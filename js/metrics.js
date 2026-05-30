'use strict';
/* ============================================================
 * RaccoonIR Metrics Engine
 * Computes:
 *   - Probability for each paragon (AND/OR rules, propagated from leaves)
 *   - Change in Operations (CiO): CiO(paragon, activities) = P_after - P_before
 *     where P_after is the paragon probability after applying activity impacts
 *     (includes indirect/propagated effects through the dependency tree)
 *   - Activity impact: per-paragon CiO and propagated change to the root goal
 * ============================================================ */

const Metrics = {

  /* ----------------------------------------------------------
   * computeProbability
   * Recursively compute probability of a paragon given the
   * full paragons map and optional override values.
   * Rules:
   *   AND  node: P = product of children's probabilities
   *   OR   node: P = 1 - product of (1 - P_child)
   *   UNCONTROLLABLE: P = leafProbability (always, even with children)
   * ---------------------------------------------------------- */
  computeProbability(paragonId, paragons, overrides = {}, project = null) {
    if (overrides[paragonId] !== undefined) return overrides[paragonId];
    const p = paragons[paragonId];
    if (!p) return 0;

    // Cross-DM proxy: delegate to original paragon in its home DM
    if (p.proxyDMId && p.proxyParagonId) {
      if (project) {
        const extDM = project.model.dependencyModels[p.proxyDMId];
        if (extDM && extDM.paragons[p.proxyParagonId]) {
          return this.computeProbability(p.proxyParagonId, extDM.paragons, overrides, project);
        }
      }
      return Math.min(1, Math.max(0, p.leafProbability));
    }

    // UNCONTROLLABLE always uses its own leafProbability, regardless of children
    if (p.type === PARAGON_TYPE.UNCONTROLLABLE) {
      return Math.min(1, Math.max(0, p.leafProbability));
    }

    const children = p.childIds.filter(id => paragons[id]);
    if (children.length === 0) {
      return Math.min(1, Math.max(0, p.leafProbability));
    }

    const childProbs = children.map(cid => this.computeProbability(cid, paragons, overrides, project));

    if (p.type === PARAGON_TYPE.AND) {
      return childProbs.reduce((acc, cp) => acc * cp, 1.0);
    } else {
      // OR
      return 1.0 - childProbs.reduce((acc, cp) => acc * (1.0 - cp), 1.0);
    }
  },

  /* ----------------------------------------------------------
   * computeAllProbabilities
   * Returns a map { paragonId -> probability } for all paragons
   * in a given dependency model.
   * ---------------------------------------------------------- */
  computeAllProbabilities(dm, project = null) {
    const result = {};
    for (const id of Object.keys(dm.paragons)) {
      result[id] = this.computeProbability(id, dm.paragons, {}, project);
    }
    return result;
  },

  /* ----------------------------------------------------------
   * computeCiO (Change in Operations)
   * CiO(paragon, activities) = P_after(paragon) - P_before(paragon)
   *
   * Measures the actual change in a paragon's operational probability
   * caused by a set of activity impacts (provided as an override map).
   * Includes propagated effects: if an activity directly raises paragonA,
   * its ancestor paragonB's probability may also change, and
   * CiO(paragonB, activities) = P_after(paragonB) - P_before(paragonB).
   *
   * @param paragonId  - the paragon to measure
   * @param paragons   - the DM's paragon map
   * @param overrides  - { paragonId -> newValue } override map (activity impacts)
   * @param project    - full project (for cross-DM proxy resolution)
   * ---------------------------------------------------------- */
  computeCiO(paragonId, paragons, overrides, project = null) {
    const baseline  = this.computeProbability(paragonId, paragons, {}, project);
    const simulated = this.computeProbability(paragonId, paragons, overrides, project);
    return simulated - baseline;
  },

  /* ----------------------------------------------------------
   * computeActivityImpactOnRoot
   * Given an activity and its ActivityImpacts, compute the
   * CiO for each directly targeted paragon and the propagated
   * effect on the root goal probability.
   * Returns an array of per-impact details plus a total root CiO.
   * ---------------------------------------------------------- */
  computeActivityImpactOnRoot(activity, project) {
    const details = [];
    let totalRootCiO = 0;

    for (const impact of activity.activityImpacts) {
      if (!impact.paragonId) continue;
      const dm = Registry.findDMForParagon(project, impact.paragonId);
      if (!dm) continue;

      const paragon = dm.paragons[impact.paragonId];
      if (!paragon) continue;

      const originalProb = this.computeProbability(impact.paragonId, dm.paragons, {}, project);
      // CiO for the directly targeted paragon = P_after - P_before = newValue - originalProb
      const paragonCiO = impact.newValue - originalProb;
      // CiO propagated to the root goal
      const rootBefore = this.computeProbability(dm.rootId, dm.paragons, {}, project);
      const rootAfter  = this.computeProbability(dm.rootId, dm.paragons, { [impact.paragonId]: impact.newValue }, project);
      const rootCiO = rootAfter - rootBefore;
      totalRootCiO += rootCiO;

      details.push({
        paragonId: impact.paragonId,
        paragonDesc: paragon.description,
        paragonType: paragon.type,
        originalProbability: originalProb,
        newValue: impact.newValue,
        paragonCiO,   // CiO(targeted paragon, {this activity}) = newValue - originalProb
        rootBefore,
        rootAfter,
        delta: rootCiO  // kept for backward compatibility
      });
    }

    return { details, total: totalRootCiO };
  },

  /* ----------------------------------------------------------
   * getMetricsReport
   * Generates a full metrics report for all DMs in the project.
   * @param project  - the RaccoonIR project
   * @param overrides - { paragonId -> newValue } activity impact overrides used
   *                    to compute CiO(paragon, activities) = P_after - P_before.
   *                    Pass {} to get CiO = 0 everywhere (no activities selected).
   * ---------------------------------------------------------- */
  getMetricsReport(project, overrides = {}) {
    const dmReports = [];

    for (const dm of Object.values(project.model.dependencyModels)) {
      const rootProb = this.computeProbability(dm.rootId, dm.paragons, {}, project);
      const paragonRows = [];

      // Use DFS order (root first)
      const order = [];
      const visitDFS = (id, depth) => {
        const p = dm.paragons[id];
        if (!p) return;
        order.push({ p, depth });
        for (const cid of p.childIds) visitDFS(cid, depth + 1);
      };
      visitDFS(dm.rootId, 0);

      for (const { p, depth } of order) {
        const prob = this.computeProbability(p.id, dm.paragons, {}, project);
        // CiO = actual probability change caused by the provided set of activity impacts
        const cio  = this.computeCiO(p.id, dm.paragons, overrides, project);
        paragonRows.push({
          id: p.id,
          depth,
          description: p.description,
          type: p.type,
          isLeaf: p.childIds.length === 0,
          leafProbability: p.leafProbability,
          computedProbability: prob,
          cio,
          rootProbability: rootProb
        });
      }

      dmReports.push({ dm, rootProbability: rootProb, paragons: paragonRows });
    }

    // Activity impact report
    const activityReports = [];
    for (const proc of Object.values(project.model.processes)) {
      if (proc.activityImpacts.length === 0) continue;
      const result = this.computeActivityImpactOnRoot(proc, project);
      if (result.details.length > 0) {
        activityReports.push({ process: proc, ...result });
      }
    }

    return { dmReports, activityReports };
  },

  /* ----------------------------------------------------------
   * probToColor
   * Map probability [0,1] to a CSS color for gauge bars.
   * ---------------------------------------------------------- */
  probToColor(prob) {
    const p = Math.max(0, Math.min(1, prob));
    if (p >= 0.7) return '#2ecc71';
    if (p >= 0.4) return '#f39c12';
    return '#e74c3c';
  },

  /* ----------------------------------------------------------
   * formatProb
   * Format probability for display.
   * ---------------------------------------------------------- */
  formatProb(prob) {
    return (prob * 100).toFixed(1) + '%';
  },

  formatCiO(cio) {
    const sign = cio > 0 ? '+' : '';
    return sign + (cio * 100).toFixed(1) + '%';
  }
};
