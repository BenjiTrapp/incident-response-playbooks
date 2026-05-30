'use strict';
/* ============================================================
 * RaccoonIR Impact View
 * Shows playbook activities (left) and a dependency model (right)
 * side by side. ActivityImpact connections are drawn as cross-pane
 * bezier arrows (red).
 *
 * Simulation modes:
 *   null      — click an activity to preview its single-activity
 *               impact on the DM (temporary, no accumulation).
 *   'execute' — click activities to mark them as "executed";
 *               all their impacts (incl. descendants) accumulate
 *               in the DM. Toggle to un-execute.
 *   'step'    — step through all activities in DFS order using
 *               Prev / Next buttons; each step adds its impacts
 *               cumulatively to the DM view.
 * ============================================================ */

class ImpactView {
  constructor(svgEl, app) {
    this.svg    = svgEl;
    this.app    = app;
    this.vp     = svgEl.querySelector('#impact-viewport');

    this.selectedRootProcessId = null;
    this.selectedDMId          = null;
    this.activeActivityId      = null;   // preview selection (null mode)
    this.activeParagonId       = null;   // highlighted paragon
    this.connectMode           = false;
    this._dragFrom             = null;   // procId during drag-to-connect

    // Simulation state
    this._simMode      = null;       // null | 'execute' | 'step'
    this._executedIds  = new Set();  // procIds marked executed (execute mode)
    this._stepQueue    = [];         // DFS-ordered procIds (step mode)
    this._stepIndex    = -1;         // current step (-1 = before start)
    this._simOverrides = {};         // accumulated paragon probability overrides

    // Expand/collapse state for the activity tree
    this._collapsed    = new Set();  // procIds whose children are hidden

    // DM pane expand/collapse
    this._dmCollapsed  = new Set();  // paragonIds whose children are hidden

    // DM pane hide/unhide
    this._hiddenParIds = new Set();  // paragonIds excluded from the DM pane

    // DM pane zoom/pan (null = auto-fit on next render)
    this._dmZoom       = null;
    this._dmPanX       = 0;
    this._dmPanY       = 0;
    this._dmIsPanning  = false;
    this._dmPanStartClientX = 0;
    this._dmPanStartClientY = 0;
    this._dmPanStartX  = 0;
    this._dmPanStartY  = 0;

    // Layout caches filled during render
    this._actNodes = {};        // procId    -> { x, y, w, h }
    this._parNodes = {};        // paragonId -> { x, y, w, h }
    this._proxyTargetMap = {};  // original paragonId -> proxy node { x, y, w, h }

    // DM pane geometry (set during render, used by event handlers)
    this._dmPaneX = 0;
    this._dmPaneY = 0;

    // DM node drag (move within the DM pane)
    this._dmDragNodeId   = null;
    this._dmDragStartX   = 0;
    this._dmDragStartY   = 0;
    this._dmDragStartNX  = 0;   // node position at drag start (model coords)
    this._dmDragStartNY  = 0;

    // DM structure connect (drag port→node to add a child edge)
    this._dmConnectFrom  = null;

    // Divider split position (ratio of total width, 0..1)
    this._divXRatio = 0.44;
    this._isDraggingDivider  = false;
    this._dividerDragStartX  = 0;
    this._dividerDragStartW  = 0;

    this._bindEvents();
  }

  /* ---- Public API ---- */

  setSelections(rootProcessId, dmId) {
    this.selectedRootProcessId = rootProcessId;
    this.selectedDMId          = dmId;
    this.activeActivityId      = null;
    this.activeParagonId       = null;
    this._dmZoom        = null;
    this._dmPanX        = 0;
    this._dmPanY        = 0;
    this._dmCollapsed   = new Set();
    this._hiddenParIds  = new Set();
    this._dmDragNodeId  = null;
    this._dmConnectFrom = null;
    this.render();
  }

  /* ---- Simulation API ---- */

  /** Switch to a simulation mode ('execute' | 'step') or back to null preview. */
  setSimMode(mode) {
    if (this._simMode === mode) mode = null;   // toggle off
    this._simMode = mode;
    this._executedIds  = new Set();
    this._simOverrides = {};
    this.activeActivityId = null;
    this.activeParagonId  = null;
    if (mode === 'step' && this.selectedRootProcessId) {
      this._stepQueue = this._buildStepQueue(this.selectedRootProcessId);
      this._stepIndex = -1;
    } else {
      this._stepQueue = [];
      this._stepIndex = -1;
    }
    this._rebuildSimOverrides();
    this.app._showNoSelection();
    this.render();
    this.app._renderViewToolbar();   // rebuild toolbar (adds/removes step controls)
  }

  /** Reset all simulation state (clears executed set, step index, overrides). */
  resetSim() {
    this._executedIds  = new Set();
    this._simOverrides = {};
    this._stepQueue    = [];
    this._stepIndex    = -1;
    this.activeActivityId = null;
    this.activeParagonId  = null;
    if (this._simMode === 'step' && this.selectedRootProcessId) {
      this._stepQueue = this._buildStepQueue(this.selectedRootProcessId);
    }
    this.app._showNoSelection();
    this.render();
  }

  /** Advance one step (step mode). */
  stepNext() {
    if (this._stepIndex >= this._stepQueue.length - 1) return;
    this._stepIndex++;
    this._rebuildSimOverrides();
    this._ensureVisible(this._stepQueue[this._stepIndex]);
    this._syncPropsForStep();
    this.render();
  }

  /** Go back one step (step mode). */
  stepPrev() {
    if (this._stepIndex < 0) return;
    this._stepIndex--;
    this._rebuildSimOverrides();
    if (this._stepIndex >= 0) this._ensureVisible(this._stepQueue[this._stepIndex]);
    this._syncPropsForStep();
    this.render();
  }

  /** Jump to a specific step index (step mode). */
  jumpToStep(idx) {
    this._stepIndex = Math.max(-1, Math.min(idx, this._stepQueue.length - 1));
    this._rebuildSimOverrides();
    if (this._stepIndex >= 0) this._ensureVisible(this._stepQueue[this._stepIndex]);
    this._syncPropsForStep();
    this.render();
  }

  /** Toggle execution of an activity (and all its descendants) in execute mode. */
  toggleExecute(procId) {
    const allIds = this._allDescendants(procId);
    const wasExecuted = this._executedIds.has(procId);
    for (const id of allIds) {
      if (wasExecuted) this._executedIds.delete(id);
      else             this._executedIds.add(id);
    }
    this._rebuildSimOverrides();
    const proc = this.app.project.model.processes[procId];
    if (proc && !wasExecuted) this.app._renderProcessProperties(proc);
    else if (wasExecuted)     this.app._showNoSelection();
    // If a paragon is currently shown in the properties panel, refresh it so
    // "After Execution" metric updates live.
    if (this.activeParagonId) {
      const dm  = Registry.findDMForParagon(this.app.project, this.activeParagonId);
      const par = dm && dm.paragons[this.activeParagonId];
      if (par) this.app._renderParagonProperties(par, dm);
    }
    this.render();
  }

  /* ---- Simulation internals ---- */

  /** Build DFS-ordered list of all activities under rootProcId (excl. root itself). */
  _buildStepQueue(rootProcId) {
    const queue = [];
    const root  = this.app.project.model.processes[rootProcId];
    if (!root) return queue;
    const visit = (id) => {
      queue.push(id);
      const p = this.app.project.model.processes[id];
      if (p) for (const sub of (p.subProcessIds || [])) visit(sub);
    };
    for (const sub of (root.subProcessIds || [])) visit(sub);
    return queue;
  }

  /** Collect procId and all descendant IDs. */
  _allDescendants(procId) {
    const ids = [procId];
    const p = this.app.project.model.processes[procId];
    if (p) for (const sub of (p.subProcessIds || []))
      ids.push(...this._allDescendants(sub));
    return ids;
  }

  /** Recompute _simOverrides from current simulation state. */
  _rebuildSimOverrides() {
    this._simOverrides = {};
    if (this._simMode === 'execute') {
      for (const id of this._executedIds) {
        const proc = this.app.project.model.processes[id];
        if (proc) for (const imp of (proc.activityImpacts || []))
          this._simOverrides[imp.paragonId] = imp.newValue;
      }
    } else if (this._simMode === 'step') {
      for (let i = 0; i <= this._stepIndex; i++) {
        const proc = this.app.project.model.processes[this._stepQueue[i]];
        if (proc) for (const imp of (proc.activityImpacts || []))
          this._simOverrides[imp.paragonId] = imp.newValue;
      }
    }
  }

  /* ---- Expand / Collapse ---- */

  /** Toggle visibility of an activity's children. */
  _toggleCollapse(procId) {
    if (this._collapsed.has(procId)) this._collapsed.delete(procId);
    else                             this._collapsed.add(procId);
    this.render();
  }

  /**
   * Ensure procId is visible by expanding all its ancestors.
   * Used when stepping to an activity that may be inside a collapsed node.
   */
  _ensureVisible(procId) {
    const findPath = (fromId, targetId, path) => {
      if (fromId === targetId) return path;
      const proc = this.app.project.model.processes[fromId];
      if (!proc) return null;
      for (const sub of (proc.subProcessIds || [])) {
        const result = findPath(sub, targetId, [...path, fromId]);
        if (result) return result;
      }
      return null;
    };
    if (!this.selectedRootProcessId) return;
    const ancestors = findPath(this.selectedRootProcessId, procId, []);
    if (ancestors) {
      let changed = false;
      for (const aid of ancestors) {
        if (this._collapsed.has(aid)) { this._collapsed.delete(aid); changed = true; }
      }
      return changed;
    }
    return false;
  }

  /** Update the Properties Panel to show the current step's activity (or paragon if one is selected). */
  _syncPropsForStep() {
    if (this.activeParagonId) {
      const dm  = Registry.findDMForParagon(this.app.project, this.activeParagonId);
      const par = dm && dm.paragons[this.activeParagonId];
      if (par) { this.app._renderParagonProperties(par, dm); return; }
    }
    if (this._stepIndex >= 0 && this._stepIndex < this._stepQueue.length) {
      const proc = this.app.project.model.processes[this._stepQueue[this._stepIndex]];
      if (proc) this.app._renderProcessProperties(proc);
    } else {
      this.app._showNoSelection();
    }
  }

  render() {
    const vp = this.vp;
    if (!vp) return;
    vp.innerHTML = '';
    this._actNodes = {};
    this._parNodes = {};
    this._proxyTargetMap = {};

    const svgR = this.svg.getBoundingClientRect();
    const W    = Math.max(svgR.width,  600);
    const H    = Math.max(svgR.height, 400);

    // Left pane width driven by _divXRatio (user-draggable)
    const DIVX = Math.max(80, Math.min(W - 80, Math.floor(W * this._divXRatio)));
    const PAD  = 14;

    this._DIVX  = DIVX;
    this._leftX = 0;
    this._leftW = DIVX;
    this._rightX = DIVX + 6;
    this._rightW = W - DIVX - 6;

    // --- backgrounds ---
    this._rect(vp, 0, 0, DIVX, H, { fill: '#0b1520' });
    this._rect(vp, DIVX + 6, 0, W - DIVX - 6, H, { fill: '#090f1a' });

    // --- vertical divider line ---
    const dvd = this._el('line');
    this._attrs(dvd, { x1: DIVX + 3, y1: 0, x2: DIVX + 3, y2: H,
                       stroke: '#2a3f5f', 'stroke-width': 2,
                       'pointer-events': 'none' });
    vp.appendChild(dvd);

    // --- divider drag handle (invisible wide hit area) ---
    const divHandle = this._el('rect');
    this._attrs(divHandle, { x: DIVX - 4, y: 0, width: 14, height: H,
                             fill: 'transparent' });
    divHandle.setAttribute('data-divider', '1');
    divHandle.style.cursor = 'col-resize';
    vp.appendChild(divHandle);

    // --- panel header labels ---
    this._panelLabel(vp, PAD, 16, 'PLAYBOOK ACTIVITIES');
    this._panelLabel(vp, this._rightX + PAD, 16, 'DEPENDENCY MODEL');

    // Hide / Unhide buttons in DM header
    if (this.selectedDMId && this.app.project.model.dependencyModels[this.selectedDMId]) {
      const dmForHdr = this.app.project.model.dependencyModels[this.selectedDMId];
      const visibleCount = Object.keys(dmForHdr.paragons).filter(id => !this._hiddenParIds.has(id)).length;
      if (visibleCount > 0) {
        const hideBtn = this._el('text');
        this._attrs(hideBtn, { x: this._rightX + PAD + 148, y: 16,
                               fill: '#c084fc', 'font-size': 9 });
        hideBtn.textContent = '\u{1F441} Hide';
        hideBtn.setAttribute('data-iv-action', 'hide-pars');
        hideBtn.style.cursor = 'pointer';
        vp.appendChild(hideBtn);
      }
      if (this._hiddenParIds.size > 0) {
        const unhideBtn = this._el('text');
        this._attrs(unhideBtn, { x: this._rightX + PAD + 192, y: 16,
                                 fill: '#2ecc71', 'font-size': 9 });
        unhideBtn.textContent = `Unhide (${this._hiddenParIds.size})`;
        unhideBtn.setAttribute('data-iv-action', 'unhide-pars');
        unhideBtn.style.cursor = 'pointer';
        vp.appendChild(unhideBtn);
      }
    }

    const sepLine = (lx, rx) => {
      const l = this._el('line');
      this._attrs(l, { x1: lx, y1: 26, x2: rx, y2: 26,
                       stroke: '#1e2d45', 'stroke-width': 1 });
      vp.appendChild(l);
    };
    sepLine(0, DIVX);
    sepLine(this._rightX, W);

    // --- content ---
    if (this.selectedRootProcessId &&
        this.app.project.model.processes[this.selectedRootProcessId]) {
      this._renderActivities(vp, PAD, 34, DIVX - PAD * 2, H - 34);
    } else {
      this._hint(vp, DIVX / 2, H / 2, 'Select a Playbook in the toolbar');
    }

    if (this.selectedDMId &&
        this.app.project.model.dependencyModels[this.selectedDMId]) {
      this._renderDM(vp, this._rightX + PAD, 34, this._rightW - PAD * 2, H - 34);
    } else {
      this._hint(vp, this._rightX + this._rightW / 2, H / 2, 'Select a Dependency Model in the toolbar');
    }

    // Connections drawn last (on top, clickable)
    this._renderConnections(vp);
  }

  /* ---- Left pane: activity list ---- */

  _renderActivities(vp, paneX, paneY, paneW, paneH) {
    const AH     = 34;
    const VGAP   = 5;
    const INDENT = 10;
    const MAX_W  = Math.min(paneW - 6, 260);
    let y        = paneY;

    const collect = (procId, depth) => {
      if (y + AH > paneY + paneH) return;   // clip to pane
      const proc = this.app.project.model.processes[procId];
      if (!proc || depth > 15) return;

      if (depth > 0) {
        const indent  = (depth - 1) * INDENT;
        const x       = paneX + indent;
        const w       = Math.max(60, MAX_W - indent);
        const hasKids = (proc.subProcessIds || []).length > 0;

        const isAct      = proc.id === this.activeActivityId;
        const hasImp     = proc.activityImpacts && proc.activityImpacts.length > 0;
        const isExecuted = this._simMode === 'execute' && this._executedIds.has(proc.id);
        const stepPos    = this._simMode === 'step' ? this._stepQueue.indexOf(proc.id) : -1;
        const isCurrent  = this._simMode === 'step' && stepPos === this._stepIndex;
        const isPast     = this._simMode === 'step' && stepPos >= 0 && stepPos < this._stepIndex;
        const isFuture   = this._simMode === 'step' && stepPos > this._stepIndex;

        const fill   = isExecuted                               ? '#0a2a10'
                     : isCurrent                               ? '#1e1a00'
                     : isPast                                  ? '#081a0a'
                     : proc.status === 'COMPLETED'             ? '#0d2210'
                     : proc.status === 'IN_PROGRESS'           ? '#22200a'
                     :                                           '#0e1828';
        const stroke = isExecuted                              ? '#2ecc71'
                     : isCurrent                               ? '#f39c12'
                     : isPast                                  ? '#27ae60'
                     : isFuture                                ? '#2a3a4a'
                     : isAct                                   ? '#a855f7'
                     : hasImp                                  ? '#c0392b'
                     :                                           '#1e2d45';
        const sw     = (isExecuted || isCurrent || isPast || isAct || hasImp) ? 2 : 1;

        const g = this._el('g');
        g.setAttribute('data-act-id', proc.id);
        g.style.cursor = 'pointer';

        this._rect(g, x, y, w, AH, { fill, stroke, 'stroke-width': sw, rx: 4 });

        // Expand / collapse triangle for composite activities
        const isCollapsed = this._collapsed.has(proc.id);
        const textOffsetX = hasKids ? 18 : 8;
        if (hasKids) {
          const tri = this._el('text');
          this._attrs(tri, {
            x: x + 9, y: y + AH / 2 + 4,
            fill: '#a855f7', 'font-size': 10, 'text-anchor': 'middle',
            'font-weight': 'bold'
          });
          tri.textContent = isCollapsed ? '▶' : '▼';
          tri.setAttribute('data-toggle-id', proc.id);
          tri.style.cursor = 'pointer';
          g.appendChild(tri);

          // Collapsed child-count badge
          if (isCollapsed) {
            const childCount = (proc.subProcessIds || []).length;
            const badge = this._el('text');
            this._attrs(badge, {
              x: x + w - 22, y: y + AH / 2 + 4,
              fill: '#a855f7', 'font-size': 9, 'text-anchor': 'middle'
            });
            badge.textContent = `+${childCount}`;
            badge.setAttribute('data-toggle-id', proc.id);
            g.appendChild(badge);
          }
        }

        // Name
        const t = this._el('text');
        this._attrs(t, { x: x + textOffsetX, y: y + AH / 2 + 4,
                         fill: isAct ? '#e4e8f0' : '#aab8cc',
                         'font-size': 11 });
        t.textContent = this._trunc(proc.name, Math.floor((w - textOffsetX - 14) / 6.5));
        g.appendChild(t);

        // Simulation state badge (overlays status dot when in sim mode)
        if (isExecuted || isPast) {
          const bt = this._el('text');
          this._attrs(bt, { x: x + w - 8, y: y + AH / 2 + 4,
                            fill: '#2ecc71', 'font-size': 11, 'text-anchor': 'middle',
                            'font-weight': 'bold' });
          bt.textContent = '✓';
          g.appendChild(bt);
        } else if (isCurrent) {
          const bt = this._el('text');
          this._attrs(bt, { x: x + w - 8, y: y + AH / 2 + 4,
                            fill: '#f39c12', 'font-size': 11, 'text-anchor': 'middle',
                            'font-weight': 'bold' });
          bt.textContent = '▶';
          g.appendChild(bt);
        } else {
          // Normal status dot
          const SC = { COMPLETED: '#2ecc71', IN_PROGRESS: '#f39c12' };
          if (SC[proc.status]) {
            const dot = this._el('circle');
            this._attrs(dot, { cx: x + w - 10, cy: y + AH / 2, r: 3,
                               fill: SC[proc.status] });
            g.appendChild(dot);
          }
        }

        // Impact count badge (suppressed in step mode for future steps to reduce noise)
        if (hasImp && !isFuture) {
          const bc = this._el('circle');
          this._attrs(bc, { cx: x + w - 10, cy: y + 7, r: 7, fill: '#7a1e1e' });
          g.appendChild(bc);
          const bt = this._el('text');
          this._attrs(bt, { x: x + w - 10, y: y + 11,
                            fill: '#ffaaaa', 'font-size': 9, 'text-anchor': 'middle' });
          bt.textContent = proc.activityImpacts.length;
          g.appendChild(bt);
        }

        // Connect handle (visible in connect mode)
        if (this.connectMode) {
          const h = this._el('circle');
          this._attrs(h, { cx: x + w, cy: y + AH / 2, r: 6,
                           fill: '#a855f7', stroke: '#fff', 'stroke-width': 1.5 });
          h.style.cursor = 'crosshair';
          h.setAttribute('data-connect-from', proc.id);
          g.appendChild(h);
        }

        vp.appendChild(g);
        this._actNodes[proc.id] = { x, y, w, h: AH };
        y += AH + VGAP;
      }

      // Only recurse if not collapsed (root at depth 0 is never in _collapsed)
      if (depth === 0 || !this._collapsed.has(procId)) {
        for (const subId of (proc.subProcessIds || [])) collect(subId, depth + 1);
      }
    };

    collect(this.selectedRootProcessId, 0);

    // Overflow hint
    if (y >= paneY + paneH) {
      const ot = this._el('text');
      this._attrs(ot, { x: paneX + MAX_W / 2, y: paneY + paneH - 6,
                        fill: '#3a4a5e', 'font-size': 10, 'text-anchor': 'middle' });
      ot.textContent = 'Collapse activities (▼) to fit more on screen';
      vp.appendChild(ot);
    }
  }

  /* ---- Right pane: DM tree ---- */

  /** Returns all parentless paragon IDs, primary dm.rootId first. */
  _dmRootIds(dm) {
    const childSet = new Set();
    for (const p of Object.values(dm.paragons)) for (const c of p.childIds) childSet.add(c);
    const roots = Object.keys(dm.paragons).filter(id => !childSet.has(id));
    if (dm.rootId && roots.includes(dm.rootId)) {
      roots.splice(roots.indexOf(dm.rootId), 1);
      roots.unshift(dm.rootId);
    }
    return roots;
  }

  /** Auto-assign nodePositions for paragons that don't have a position yet. */
  _ensureIVLayout(dm, view) {
    const NW = 160, NH = 60, HGAP = 30, VGAP = 80;
    if (Object.keys(dm.paragons).every(id => view.nodePositions[id])) return;

    const childSet = new Set();
    for (const p of Object.values(dm.paragons)) for (const c of p.childIds) childSet.add(c);
    const roots = Object.keys(dm.paragons).filter(id => !childSet.has(id));
    if (dm.rootId && roots.includes(dm.rootId)) {
      roots.splice(roots.indexOf(dm.rootId), 1); roots.unshift(dm.rootId);
    }

    const placed = new Set();
    const subW = (id) => {
      const p = dm.paragons[id];
      if (!p || p.childIds.length === 0) return NW + HGAP;
      return Math.max(p.childIds.reduce((s, c) => s + subW(c), 0) - HGAP, NW + HGAP);
    };
    const layout = (id, x, y) => {
      if (placed.has(id)) return;
      placed.add(id);
      const p = dm.paragons[id];
      if (!p) return;
      if (!view.nodePositions[id]) {
        const sw = subW(id);
        view.nodePositions[id] = { x: x + (sw - HGAP) / 2 - NW / 2, y };
      }
      let cx = x;
      for (const cid of p.childIds) { layout(cid, cx, y + NH + VGAP); cx += subW(cid); }
    };

    let offsetX = 0;
    for (const rootId of roots) { layout(rootId, offsetX, 0); offsetX += subW(rootId) + 60; }

    // Place any remaining unplaced nodes below everything
    const yMax = Object.values(view.nodePositions).reduce((m, p) => Math.max(m, p.y), 0);
    let strayX = 0;
    for (const id of Object.keys(dm.paragons)) {
      if (!view.nodePositions[id]) {
        view.nodePositions[id] = { x: strayX, y: yMax + NH + VGAP };
        strayX += NW + HGAP;
      }
    }
  }

  _renderDM(vp, paneX, paneY, paneW, paneH) {
    const dm   = this.app.project.model.dependencyModels[this.selectedDMId];
    if (!dm) return;
    const pars = dm.paragons;
    if (!pars || Object.keys(pars).length === 0) return;

    // Get/init shared representation view (positions shared with DM Editor)
    const proj = this.app.project;
    if (!proj.representation.dmViews[dm.id]) {
      proj.representation.dmViews[dm.id] = { nodePositions: {}, zoom: 1, panX: 0, panY: 0 };
    }
    const view = proj.representation.dmViews[dm.id];
    this._ensureIVLayout(dm, view);

    // Store pane geometry for event handlers
    this._dmPaneX = paneX;
    this._dmPaneY = paneY;
    this._dmPaneW = paneW;
    this._dmPaneH = paneH;

    const NW = 160, NH = 60;

    const isVisible = (id) => !this._hiddenParIds.has(id) && !!pars[id];

    // Reachable set: DFS from all roots, stopping at collapsed nodes
    const reachable = new Set();
    const childSet  = new Set();
    for (const p of Object.values(pars)) for (const c of p.childIds) childSet.add(c);
    const roots = Object.keys(pars).filter(id => !childSet.has(id) && isVisible(id));
    if (dm.rootId && roots.includes(dm.rootId)) {
      roots.splice(roots.indexOf(dm.rootId), 1); roots.unshift(dm.rootId);
    }
    const markReachable = (id) => {
      if (reachable.has(id) || !isVisible(id)) return;
      reachable.add(id);
      const p = pars[id];
      if (!p || this._dmCollapsed.has(id)) return;
      for (const cid of p.childIds) markReachable(cid);
    };
    for (const rootId of roots) markReachable(rootId);

    if (reachable.size === 0) {
      this._hint(vp, paneX + paneW / 2, paneY + paneH / 2,
                 this._hiddenParIds.size > 0 ? 'All paragons hidden — use Unhide to restore' : 'No paragons');
      return;
    }

    // Auto-fit zoom/pan if not yet set
    if (this._dmZoom === null) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of reachable) {
        const pos = view.nodePositions[id];
        if (!pos) continue;
        minX = Math.min(minX, pos.x);       minY = Math.min(minY, pos.y);
        maxX = Math.max(maxX, pos.x + NW);  maxY = Math.max(maxY, pos.y + NH + 20);
      }
      if (!isFinite(minX)) { minX = 0; minY = 0; maxX = NW; maxY = NH; }
      const cW = (maxX - minX) || 1, cH = (maxY - minY) || 1;
      const FP = 12;
      this._dmZoom = Math.min((paneW - FP * 2) / cW, (paneH - FP * 2) / cH, 1.5);
      this._dmPanX = (paneW - cW * this._dmZoom) / 2 - minX * this._dmZoom;
      this._dmPanY = FP - minY * this._dmZoom;
    }

    const Z    = this._dmZoom;
    const nW   = NW * Z;
    const nH   = NH * Z;
    const toScr = (pos) => ({
      x: paneX + this._dmPanX + pos.x * Z,
      y: paneY + this._dmPanY + pos.y * Z
    });

    // Clip path
    const clipId = 'dm-pane-clip';
    let defs = vp.querySelector('defs');
    if (!defs) { defs = this._el('defs'); vp.insertBefore(defs, vp.firstChild); }
    let cp = defs.querySelector(`#${clipId}`);
    if (!cp) {
      cp = this._el('clipPath'); cp.setAttribute('id', clipId);
      const cr2 = this._el('rect'); defs.appendChild(cp); cp.appendChild(cr2);
    }
    this._attrs(cp.querySelector('rect'), { x: paneX, y: paneY, width: paneW, height: paneH });

    const dmGroup = this._el('g');
    dmGroup.setAttribute('clip-path', `url(#${clipId})`);

    const overrides = this._activeOverrides();

    // Draw edges (only between reachable nodes whose parent is not collapsed)
    for (const id of reachable) {
      if (this._dmCollapsed.has(id)) continue;
      const p = pars[id];
      if (!p || !view.nodePositions[id]) continue;
      const ps = toScr(view.nodePositions[id]);
      for (const cid of p.childIds) {
        if (!reachable.has(cid) || !view.nodePositions[cid]) continue;
        const cs      = toScr(view.nodePositions[cid]);
        const isProxy = !!(pars[cid] && pars[cid].proxyDMId);
        const x1 = ps.x + nW / 2, y1 = ps.y + nH;
        const x2 = cs.x + nW / 2, y2 = cs.y;
        const edgeAttrs = {
          d: `M${x1},${y1} C${x1},${y1 + 10 * Z} ${x2},${y2 - 10 * Z} ${x2},${y2}`,
          fill: 'none', stroke: isProxy ? '#3a5080' : '#1e2d45',
          'stroke-width': Z < 0.5 ? 1 : 1.5
        };
        if (isProxy) edgeAttrs['stroke-dasharray'] = `${4 * Z} ${3 * Z}`;
        const edge = this._el('path');
        this._attrs(edge, edgeAttrs);
        dmGroup.appendChild(edge);
      }
    }

    // Draw nodes
    for (const id of reachable) {
      const p        = pars[id];
      const modelPos = view.nodePositions[id];
      if (!p || !modelPos) continue;

      const pos      = toScr(modelPos);
      const isProxy  = !!(p.proxyDMId && p.proxyParagonId);
      const isRoot   = id === dm.rootId;
      const isActive = id === this.activeParagonId;
      const isImp    = overrides[id] !== undefined;
      const isColl   = this._dmCollapsed.has(id);
      const visKids  = p.childIds.filter(isVisible);
      const hasKids  = visKids.length > 0;

      // Resolve proxy display info
      let displayDesc = p.description;
      let proxyDMName = '';
      if (isProxy) {
        const extDM = proj.model.dependencyModels[p.proxyDMId];
        if (extDM && extDM.paragons[p.proxyParagonId]) {
          displayDesc = extDM.paragons[p.proxyParagonId].description;
          proxyDMName = extDM.name || '';
        }
      }

      const prob     = Metrics.computeProbability(id, pars, overrides, proj);
      const origProb = Metrics.computeProbability(id, pars, {}, proj);
      const changed  = Math.abs(prob - origProb) > 0.0005;

      const fill   = prob >= 0.7 ? '#0a2e14' : (prob >= 0.4 ? '#2e1e00' : '#2e0a0a');
      // Highlight both directly impacted nodes (isImp) and nodes whose probability
      // changed due to propagation through the dependency tree (changed includes proxies
      // and their ancestors when the override targets a paragon in another DM)
      const stroke = isActive ? '#a855f7' : ((isImp || changed) ? '#ff7043' : Metrics.probToColor(prob));
      const sw     = (isActive || isImp || changed) ? 2 : 1;

      const g = this._el('g');
      g.setAttribute('data-par-id', id);
      g.style.cursor = 'pointer';

      // Node box
      const boxAttrs = { fill, stroke, 'stroke-width': sw, rx: Math.max(2, 4 * Z) };
      if (isProxy) boxAttrs['stroke-dasharray'] = `${5 * Z} ${3 * Z}`;
      this._rect(g, pos.x, pos.y, nW, nH, boxAttrs);

      // Root indicator (gold top bar)
      if (isRoot) {
        const ri = this._el('rect');
        this._attrs(ri, { x: pos.x, y: pos.y, width: nW, height: Math.max(2, 3 * Z),
                          fill: '#f39c12', rx: Math.max(2, 4 * Z) });
        g.appendChild(ri);
      }

      // Type / proxy badge
      const bfs = Math.max(7, Math.round(8 * Z));
      if (isProxy) {
        const badge = this._el('text');
        this._attrs(badge, { x: pos.x + nW - 3, y: pos.y + bfs + 2, 'text-anchor': 'end',
                             fill: '#c084fc', 'font-size': bfs, 'pointer-events': 'none' });
        badge.textContent = `\u2197${this._trunc(proxyDMName, 10)}`;
        g.appendChild(badge);
      } else {
        const typeColors = { AND: '#a855f7', OR: '#9b59b6', UNCONTROLLABLE: '#e67e22' };
        const badge = this._el('text');
        this._attrs(badge, { x: pos.x + 3, y: pos.y + bfs + 2,
                             fill: typeColors[p.type] || '#a855f7', 'font-size': bfs,
                             'pointer-events': 'none' });
        badge.textContent = p.type;
        g.appendChild(badge);
      }

      // Description
      const ns = Math.max(8, Math.round(11 * Z));
      const t  = this._el('text');
      this._attrs(t, { x: pos.x + nW / 2, y: pos.y + nH * 0.42,
                       fill: isProxy ? '#8899b0' : '#ccd6e0', 'font-size': ns,
                       'text-anchor': 'middle', 'dominant-baseline': 'middle' });
      t.textContent = this._trunc(displayDesc, Math.floor(nW / (ns * 0.62)));
      g.appendChild(t);

      // Probability bar
      const barY = pos.y + nH * 0.65;
      const barH = Math.max(2, 3 * Z);
      const barW = nW - 8;
      this._rect(g, pos.x + 4, barY, barW,        barH, { fill: '#1e2d3a' });
      this._rect(g, pos.x + 4, barY, barW * prob,  barH, { fill: Metrics.probToColor(prob) });

      // Probability text
      const ps2 = Math.max(7, Math.round(9 * Z));
      const pt  = this._el('text');
      this._attrs(pt, { x: pos.x + nW / 2, y: pos.y + nH * 0.87,
                        fill: Metrics.probToColor(prob), 'font-size': ps2, 'text-anchor': 'middle' });
      pt.textContent = changed
        ? `${Metrics.formatProb(origProb)} \u2192 ${Metrics.formatProb(prob)}`
        : Metrics.formatProb(prob);
      g.appendChild(pt);

      // Impact badge (shown for directly impacted nodes and propagated ancestors)
      if (isImp || changed) {
        const badge = this._el('text');
        this._attrs(badge, { x: pos.x + nW - 4, y: pos.y + 10,
                             fill: '#ff7043', 'font-size': Math.max(7, 9 * Z), 'text-anchor': 'end' });
        badge.textContent = '\u25b2';
        g.appendChild(badge);
      }

      // SVG tooltip
      const titleEl = this._el('title');
      titleEl.textContent = changed
        ? `${displayDesc}\n${Metrics.formatProb(origProb)} \u2192 ${Metrics.formatProb(prob)}`
        : `${displayDesc}\n${Metrics.formatProb(prob)}`;
      g.appendChild(titleEl);

      // Collapse toggle (non-leaf, sufficient zoom)
      if (hasKids && Z >= 0.35) {
        const bw = Math.max(20, 32 * Z), bh = Math.max(9, 12 * Z);
        const bx = pos.x + nW / 2 - bw / 2;
        const by = pos.y + nH + 2;
        this._rect(g, bx, by, bw, bh, { fill: isColl ? '#1a2e50' : '#0e1a2e',
                                         stroke: '#2e4a70', 'stroke-width': 1,
                                         rx: Math.max(2, 3 * Z) });
        const bts = Math.max(7, Math.round(8 * Z));
        const btn = this._el('text');
        this._attrs(btn, { x: pos.x + nW / 2, y: by + bh - 2, 'text-anchor': 'middle',
                           fill: '#6aaeff', 'font-size': bts, 'pointer-events': 'none' });
        btn.textContent = isColl ? `\u25b6${visKids.length}` : '\u25bc';
        g.appendChild(btn);
        const toggleHit = this._el('rect');
        this._attrs(toggleHit, { x: bx, y: by, width: bw, height: bh, fill: 'transparent' });
        toggleHit.setAttribute('data-dm-toggle-id', id);
        toggleHit.style.cursor = 'pointer';
        g.appendChild(toggleHit);
      }

      // DM-structure connect port (right edge, non-proxy only)
      if (!isProxy) {
        const port = this._el('circle');
        this._attrs(port, { cx: pos.x + nW, cy: pos.y + nH / 2, r: Math.max(4, 5 * Z),
                            fill: '#1a0a2e', stroke: '#a855f7', 'stroke-width': 1 });
        port.setAttribute('data-dm-from', id);
        port.style.cursor = 'crosshair';
        g.appendChild(port);
      }

      // ActivityImpact connect handle (left edge, in connect mode)
      if (this.connectMode) {
        const h = this._el('circle');
        this._attrs(h, { cx: pos.x, cy: pos.y + nH / 2, r: 6,
                         fill: '#2ecc71', stroke: '#fff', 'stroke-width': 1.5 });
        h.style.cursor = 'crosshair';
        h.setAttribute('data-connect-to', id);
        g.appendChild(h);
      }

      dmGroup.appendChild(g);
      this._parNodes[id] = { x: pos.x, y: pos.y, w: nW, h: nH };
      // Allow ActivityImpact arrows that target the original paragon to find this proxy node
      if (isProxy) this._proxyTargetMap[p.proxyParagonId] = this._parNodes[id];
    }

    vp.appendChild(dmGroup);

    // Hint text
    const hint = this._el('text');
    this._attrs(hint, { x: paneX + paneW - 4, y: paneY + paneH - 4,
                        fill: '#2a3a50', 'font-size': 9, 'text-anchor': 'end' });
    hint.textContent = 'scroll to zoom \u00b7 drag node to move \u00b7 right-click for menu';
    vp.appendChild(hint);
  }

  /** Reset DM pane to auto-fit and re-render */
  _resetDMView() {
    this._dmZoom = null;
    this._dmPanX = 0;
    this._dmPanY = 0;
    this.render();
  }

  /* ---- Connections (ActivityImpact arrows) ---- */

  _renderConnections(vp) {
    if (!this.selectedRootProcessId) return;

    const connG = this._el('g');
    connG.setAttribute('id', 'impact-conn-group');

    const draw = (procId) => {
      const proc = this.app.project.model.processes[procId];
      if (!proc) return;

      for (const imp of (proc.activityImpacts || [])) {
        const aN = this._actNodes[procId];
        const pN = this._parNodes[imp.paragonId] || this._proxyTargetMap[imp.paragonId];
        if (!aN || !pN) continue;

        const isHL  = procId === this.activeActivityId
                   || imp.paragonId === this.activeParagonId;
        const color = isHL ? '#ff7043' : '#c0392b';
        const sw    = isHL ? 2.5 : 1.5;
        const opac  = isHL ? 1 : 0.7;

        const x1 = aN.x + aN.w;
        const y1 = aN.y + aN.h / 2;
        const x2 = pN.x;
        const y2 = pN.y + pN.h / 2;
        const cp = Math.max(40, (x2 - x1) * 0.45);

        const dPath = `M${x1},${y1} C${x1+cp},${y1} ${x2-cp},${y2} ${x2},${y2}`;

        // Visible arrow
        const path = this._el('path');
        this._attrs(path, {
          d: dPath, fill: 'none', stroke: color,
          'stroke-width': sw, 'stroke-opacity': opac,
          'marker-end': 'url(#impact-arrow)'
        });
        path.setAttribute('data-imp-proc', procId);
        path.setAttribute('data-imp-par',  imp.paragonId);
        path.style.cursor = 'pointer';
        connG.appendChild(path);

        // Wide invisible hit area
        const hit = this._el('path');
        this._attrs(hit, { d: dPath, fill: 'none', stroke: 'transparent', 'stroke-width': 12 });
        hit.setAttribute('data-imp-proc', procId);
        hit.setAttribute('data-imp-par',  imp.paragonId);
        hit.style.cursor = 'pointer';
        connG.appendChild(hit);

        // Label at midpoint
        const mx  = (x1 + x2) / 2;
        const my  = (y1 + y2) / 2;
        const bg  = this._el('rect');
        this._attrs(bg, { x: mx - 20, y: my - 8, width: 40, height: 13,
                          rx: 3, fill: '#090f1a', 'fill-opacity': 0.88 });
        connG.appendChild(bg);

        const lbl = this._el('text');
        this._attrs(lbl, { x: mx, y: my + 1, fill: color, 'font-size': 9,
                           'text-anchor': 'middle', 'dominant-baseline': 'middle' });
        lbl.textContent = `p=${Metrics.formatProb(imp.newValue)}`;
        lbl.setAttribute('data-imp-proc', procId);
        lbl.setAttribute('data-imp-par',  imp.paragonId);
        lbl.style.pointerEvents = 'none';
        connG.appendChild(lbl);
      }

      for (const subId of (proc.subProcessIds || [])) draw(subId);
    };

    draw(this.selectedRootProcessId);
    vp.appendChild(connG);
  }

  /* ---- Events ---- */

  _bindEvents() {
    this.svg.addEventListener('click',       e => this._onClick(e));
    this.svg.addEventListener('mousedown',   e => this._onMouseDown(e));
    this.svg.addEventListener('mousemove',   e => this._onMouseMove(e));
    this.svg.addEventListener('mouseup',     e => this._onMouseUp(e));
    this.svg.addEventListener('mouseleave',  () => {
      if (this._isDraggingDivider) { this._isDraggingDivider = false; this.svg.style.cursor = ''; }
      if (this._dmIsPanning)   this._dmIsPanning = false;
      if (this._dmDragNodeId)  { this._dmDragNodeId = null; this.app._markDirty(); }
      if (this._dmConnectFrom) {
        this._dmConnectFrom = null;
        const dl = this.vp && this.vp.querySelector('#dm-connect-drag-line');
        if (dl) dl.remove();
      }
    });
    this.svg.addEventListener('contextmenu', e => this._onContextMenu(e));
    this.svg.addEventListener('wheel',       e => this._onWheel(e), { passive: false });
  }

  _onWheel(e) {
    const rect = this.svg.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    if (!this._DIVX || mx <= this._DIVX + 6) return;  // only zoom DM pane

    e.preventDefault();

    if (this._dmZoom === null) this._dmZoom = 1;  // initialise if needed

    const factor  = e.deltaY < 0 ? 1.15 : 0.87;
    const paneRelX = mx - (this._dmPaneX || 0);
    const paneRelY = (e.clientY - rect.top) - (this._dmPaneY || 0);

    // Zoom centred on mouse position within the DM pane
    this._dmPanX = paneRelX - (paneRelX - this._dmPanX) * factor;
    this._dmPanY = paneRelY - (paneRelY - this._dmPanY) * factor;
    this._dmZoom = Math.max(0.1, Math.min(5, this._dmZoom * factor));

    this.render();
  }

  _toggleDMCollapse(paragonId) {
    if (this._dmCollapsed.has(paragonId)) this._dmCollapsed.delete(paragonId);
    else this._dmCollapsed.add(paragonId);
    this.render();
  }

  _onClick(e) {
    // Ignore if we were dragging
    if (this._wasDragging) { this._wasDragging = false; return; }

    // Hide / Unhide buttons in DM header
    const ivAction = e.target.getAttribute('data-iv-action');
    if (ivAction === 'hide-pars')   { this._showHideModal();   return; }
    if (ivAction === 'unhide-pars') { this._showUnhideModal(); return; }

    // DM paragon collapse toggle
    const dmToggle = e.target.getAttribute('data-dm-toggle-id');
    if (dmToggle) { this._toggleDMCollapse(dmToggle); return; }

    // Activity expand / collapse toggle
    const toggleId = e.target.getAttribute('data-toggle-id');
    if (toggleId) { this._toggleCollapse(toggleId); return; }

    if (this.connectMode) {
      // Click-to-connect: click activity to start, click paragon to finish
      const gActC = e.target.closest('[data-act-id]');
      const gParC = e.target.closest('[data-par-id]');
      if (gActC && !this._dragFrom) {
        this._dragFrom = gActC.getAttribute('data-act-id');
        return;
      }
      if (gParC && this._dragFrom) {
        this._createImpact(this._dragFrom, gParC.getAttribute('data-par-id'));
        this._dragFrom = null;
        return;
      }
    }

    const gAct = e.target.closest('[data-act-id]');
    const gPar = e.target.closest('[data-par-id]');

    if (gAct) {
      const id = gAct.getAttribute('data-act-id');
      if (this._simMode === 'execute') {
        // Execute mode: toggle execution of this activity + descendants
        this.toggleExecute(id);
      } else if (this._simMode === 'step') {
        // Step mode: clicking jumps to that step
        const idx = this._stepQueue.indexOf(id);
        if (idx >= 0) this.jumpToStep(idx);
      } else {
        // Preview mode: single-activity impact preview
        this.activeActivityId = (id === this.activeActivityId) ? null : id;
        this.activeParagonId  = null;
        this.render();
        if (this.activeActivityId) {
          const proc = this.app.project.model.processes[this.activeActivityId];
          if (proc) this.app._renderProcessProperties(proc);
        } else {
          this.app._showNoSelection();
        }
      }
    } else if (gPar) {
      const id = gPar.getAttribute('data-par-id');
      this.activeParagonId  = (id === this.activeParagonId) ? null : id;
      this.activeActivityId = null;
      this.render();
      if (this.activeParagonId) {
        const dm  = Registry.findDMForParagon(this.app.project, this.activeParagonId);
        const par = dm && dm.paragons[this.activeParagonId];
        if (par && dm) this.app._renderParagonProperties(par, dm);
      } else {
        this.app._showNoSelection();
      }
    } else if (!e.target.getAttribute('data-imp-proc')) {
      if (this.activeActivityId || this.activeParagonId) {
        this.activeActivityId = null;
        this.activeParagonId  = null;
        this.app._showNoSelection();
        this.render();
      }
    }
  }

  _onMouseDown(e) {
    if (this.connectMode) {
      // Allow drag-to-connect from anywhere on an activity node (not just the port circle)
      const actEl = e.target.closest('[data-act-id]');
      if (actEl) {
        this._dragFrom = actEl.getAttribute('data-act-id');
        this._wasDragging = false;
        e.preventDefault();
        return;
      }
    }

    if (e.button !== 0) return;

    // Divider drag — takes priority
    if (e.target.getAttribute('data-divider')) {
      const rect = this.svg.getBoundingClientRect();
      this._isDraggingDivider = true;
      this._wasDragging = false;
      this._dividerDragStartX = e.clientX;
      this._dividerDragStartRatio = this._divXRatio;
      this._dividerTotalW = rect.width;
      this.svg.style.cursor = 'col-resize';
      e.preventDefault();
      return;
    }

    if (!this.connectMode) {
      const rect       = this.svg.getBoundingClientRect();
      const mx         = e.clientX - rect.left;
      const isInDMPane = this._DIVX && mx > this._DIVX + 6;

      if (isInDMPane) {
        // DM-structure connect port drag (right-edge port of DM node)
        const dmFromAttr = e.target.getAttribute('data-dm-from');
        if (dmFromAttr) {
          this._dmConnectFrom = dmFromAttr;
          this._wasDragging   = false;
          e.preventDefault();
          return;
        }

        // DM node drag (click on node body, not toggle/port)
        const parEl    = e.target.closest('[data-par-id]');
        const onToggle = e.target.getAttribute('data-dm-toggle-id');
        const onPort   = e.target.getAttribute('data-connect-to');
        if (parEl && !onToggle && !onPort && this.selectedDMId) {
          const nodeId = parEl.getAttribute('data-par-id');
          const dm     = this.app.project.model.dependencyModels[this.selectedDMId];
          if (dm && dm.paragons[nodeId]) {
            const view     = this.app.project.representation.dmViews[dm.id];
            const modelPos = view && view.nodePositions[nodeId];
            if (modelPos && this._dmZoom) {
              this._dmDragNodeId  = nodeId;
              this._dmDragStartX  = mx;
              this._dmDragStartY  = e.clientY - rect.top;
              this._dmDragStartNX = modelPos.x;
              this._dmDragStartNY = modelPos.y;
              this._wasDragging   = false;
              e.preventDefault();
              return;
            }
          }
        }

        // DM pane pan — drag on empty DM background
        const onNode = e.target.closest('[data-par-id]');
        if (!onNode && !onToggle) {
          this._dmIsPanning = true;
          this._wasDragging = false;
          this._dmPanStartClientX = e.clientX;
          this._dmPanStartClientY = e.clientY;
          this._dmPanStartX = this._dmPanX;
          this._dmPanStartY = this._dmPanY;
          if (this._dmZoom === null) this._dmZoom = 1;
          e.preventDefault();
        }
      }
    }
  }

  _onMouseMove(e) {
    // Divider drag
    if (this._isDraggingDivider) {
      const dx = e.clientX - this._dividerDragStartX;
      const totalW = this._dividerTotalW || 800;
      const newRatio = this._dividerDragStartRatio + dx / totalW;
      this._divXRatio = Math.max(0.15, Math.min(0.85, newRatio));
      this._dmZoom = null;  // auto-refit DM pane on resize
      this._wasDragging = true;
      this.render();
      return;
    }

    // DM pane pan
    if (this._dmIsPanning) {
      const dx = e.clientX - this._dmPanStartClientX;
      const dy = e.clientY - this._dmPanStartClientY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._wasDragging = true;
      this._dmPanX = this._dmPanStartX + dx;
      this._dmPanY = this._dmPanStartY + dy;
      this.render();
      return;
    }

    // DM node drag — update nodePositions in shared view
    if (this._dmDragNodeId) {
      const rect = this.svg.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;
      const dx   = mx - this._dmDragStartX;
      const dy   = my - this._dmDragStartY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._wasDragging = true;
      const dm = this.app.project.model.dependencyModels[this.selectedDMId];
      if (dm && this._dmZoom) {
        const view = this.app.project.representation.dmViews[dm.id];
        if (view) {
          view.nodePositions[this._dmDragNodeId] = {
            x: this._dmDragStartNX + dx / this._dmZoom,
            y: this._dmDragStartNY + dy / this._dmZoom
          };
          this.render();
        }
      }
      return;
    }

    // DM structure connect drag — preview bezier line
    if (this._dmConnectFrom) {
      this._wasDragging = true;
      const rect = this.svg.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const my   = e.clientY - rect.top;
      const fromN = this._parNodes[this._dmConnectFrom];
      if (fromN) {
        const x1 = fromN.x + fromN.w, y1 = fromN.y + fromN.h / 2;
        const cp = Math.max(20, (mx - x1) * 0.5);
        let dl = this.vp.querySelector('#dm-connect-drag-line');
        if (!dl) {
          dl = this._el('path');
          dl.setAttribute('id', 'dm-connect-drag-line');
          this._attrs(dl, { fill: 'none', stroke: '#a855f7',
                            'stroke-width': 2, 'stroke-dasharray': '6 3' });
          dl.style.pointerEvents = 'none';
          this.vp.appendChild(dl);
        }
        dl.setAttribute('d', `M${x1},${y1} C${x1+cp},${y1} ${mx-cp},${my} ${mx},${my}`);
      }
      return;
    }

    // ActivityImpact drag — preview bezier line
    if (!this._dragFrom) return;
    this._wasDragging = true;

    const rect = this.svg.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    const aN = this._actNodes[this._dragFrom];
    if (!aN) return;

    const x1 = aN.x + aN.w, y1 = aN.y + aN.h / 2;
    const cp = Math.max(20, (mx - x1) * 0.5);

    let dl = this.vp.querySelector('#impact-drag-line');
    if (!dl) {
      dl = this._el('path');
      dl.setAttribute('id', 'impact-drag-line');
      this._attrs(dl, { fill: 'none', stroke: '#a855f7',
                        'stroke-width': 2, 'stroke-dasharray': '6 3' });
      dl.style.pointerEvents = 'none';
      this.vp.appendChild(dl);
    }
    dl.setAttribute('d', `M${x1},${y1} C${x1+cp},${y1} ${mx-cp},${my} ${mx},${my}`);
  }

  _onMouseUp(e) {
    if (this._isDraggingDivider) {
      this._isDraggingDivider = false;
      this.svg.style.cursor = '';
      return;
    }
    if (this._dmIsPanning) {
      this._dmIsPanning = false;
      return;
    }
    if (this._dmDragNodeId) {
      const wasDrag = this._wasDragging;
      this._dmDragNodeId = null;
      if (wasDrag) {
        this.app._markDirty();
        this.render();
        return;   // genuine drag: suppress the upcoming click event
      }
      // Plain click (no movement): let _onClick handle selection normally
      return;
    }
    if (this._dmConnectFrom) {
      const fromId = this._dmConnectFrom;
      this._dmConnectFrom = null;
      const dl = this.vp.querySelector('#dm-connect-drag-line');
      if (dl) dl.remove();
      const parEl = e.target.closest('[data-par-id]');
      if (parEl) {
        const toId = parEl.getAttribute('data-par-id');
        if (toId !== fromId && this.selectedDMId) {
          const dm = this.app.project.model.dependencyModels[this.selectedDMId];
          if (dm) this.app.dmConnectNodes(fromId, toId, dm);
        }
      }
      return;
    }
    if (!this._dragFrom) return;
    // Accept drop anywhere on a paragon node (not just the port circle)
    let cto = e.target.getAttribute('data-connect-to');
    if (!cto) {
      const parEl = e.target.closest('[data-par-id]');
      if (parEl) cto = parEl.getAttribute('data-par-id');
    }
    if (cto) this._createImpact(this._dragFrom, cto);
    this._dragFrom = null;
    const dl = this.vp.querySelector('#impact-drag-line');
    if (dl) dl.remove();
  }

  _onContextMenu(e) {
    e.preventDefault();

    // Impact connection right-click
    const impProcId = e.target.getAttribute('data-imp-proc');
    const impParId  = e.target.getAttribute('data-imp-par');
    if (impProcId && impParId) {
      this.app.showImpactContextMenu(e, impProcId, impParId, this);
      return;
    }

    // DM node right-click
    if (this.selectedDMId) {
      const rect = this.svg.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      if (this._DIVX && mx > this._DIVX + 6) {
        const parEl = e.target.closest('[data-par-id]');
        if (parEl) {
          const nodeId = parEl.getAttribute('data-par-id');
          const dm     = this.app.project.model.dependencyModels[this.selectedDMId];
          if (dm && dm.paragons[nodeId]) this._showDMNodeContextMenu(e, nodeId, dm);
        }
      }
    }
  }

  _showDMNodeContextMenu(e, nodeId, dm) {
    const p = dm.paragons[nodeId];
    if (!p) return;
    const items = [];

    if (p.proxyDMId && p.proxyParagonId) {
      const extDM   = this.app.project.model.dependencyModels[p.proxyDMId];
      const dmLabel = extDM ? extDM.name : p.proxyDMId;
      items.push({ label: `\u2197 Open in "${dmLabel}"`,
                   fn: () => this.app._navigateToProxySource(p) });
      items.push({ sep: true });
      items.push({ label: '\u2702 Remove cross-DM reference', danger: true,
                   fn: () => this.app._deleteParagonOnly(nodeId, dm) });
    } else {
      items.push({ label: '+ AND child',
                   fn: () => this.app._addParagonChildTo(nodeId, PARAGON_TYPE.AND, dm) });
      items.push({ label: '+ OR child',
                   fn: () => this.app._addParagonChildTo(nodeId, PARAGON_TYPE.OR, dm) });
      items.push({ label: '+ Leaf',
                   fn: () => this.app._addParagonChildTo(nodeId, PARAGON_TYPE.UNCONTROLLABLE, dm) });
      items.push({ label: '\u{1F310} Add cross-DM child\u2026',
                   fn: () => this.app._addCrossDMChild(nodeId, dm) });
      if (p.childIds.length > 0) {
        items.push({ sep: true });
        const isColl = this._dmCollapsed.has(nodeId);
        items.push({ label: isColl ? '\u25b6 Expand Children' : '\u25bc Collapse Children',
                     fn: () => {
                       if (isColl) this._dmCollapsed.delete(nodeId);
                       else        this._dmCollapsed.add(nodeId);
                       this.render();
                     }});
      }
      items.push({ sep: true });
      items.push({ label: '\ud83d\uddd1 Delete node', danger: true,
                   fn: () => this.app._deleteParagonOnly(nodeId, dm) });
      items.push({ label: '\ud83d\uddd1 Delete with children', danger: true,
                   fn: () => this.app._deleteParagonWithChildren(nodeId, dm) });
    }

    this.app._showContextMenu(e, items);
  }

  /* ---- Create / edit impact ---- */

  _createImpact(procId, paragonId) {
    const proc    = this.app.project.model.processes[procId];
    if (!proc) return;
    const dm      = Registry.findDMForParagon(this.app.project, paragonId);
    const par     = dm && dm.paragons[paragonId];
    const origP   = par ? Metrics.computeProbability(paragonId, dm.paragons, {}, this.app.project) : 0;
    const existing = proc.activityImpacts.find(i => i.paragonId === paragonId);

    this.app.showModal('Activity Impact',
      `<p style="font-size:11px;color:#8899b0;margin-bottom:10px">
         <b>${this.app._esc(proc.name)}</b> &rarr; <b>${this.app._esc(par ? par.description : paragonId)}</b>
       </p>
       <div class="prop-row">
         <label class="prop-label">New Probability (0&ndash;1)</label>
         <input id="imp-val" type="number" min="0" max="1" step="0.01"
                value="${existing ? existing.newValue : 1.0}" style="width:100%">
       </div>
       <p style="font-size:10px;color:#5a6880;margin-top:6px">
         Original probability: ${Metrics.formatProb(origP)}
       </p>`,
      () => {
        const nv = Math.min(1, Math.max(0,
          parseFloat(document.getElementById('imp-val').value) || 0));
        this.app._pushUndo();
        if (existing) {
          existing.newValue = nv;
        } else {
          proc.activityImpacts.push(createActivityImpact(paragonId, nv));
        }
        this.app._markDirty();
        this.render();
        // Keep properties panel in sync
        if (this.activeActivityId === procId) this.app._renderProcessProperties(proc);
      }
    );
  }

  /* ---- Helpers ---- */

  _activeOverrides() {
    // In a simulation mode, always use the accumulated overrides
    if (this._simMode) return this._simOverrides;
    // Preview mode: single clicked activity
    if (!this.activeActivityId) return {};
    const proc = this.app.project.model.processes[this.activeActivityId];
    if (!proc) return {};
    const ov = {};
    for (const imp of (proc.activityImpacts || []))
      if (imp.paragonId) ov[imp.paragonId] = imp.newValue;
    return ov;
  }

  _el(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  _attrs(el, map) {
    for (const [k, v] of Object.entries(map)) el.setAttribute(k, v);
  }

  _rect(parent, x, y, w, h, opts) {
    const r = this._el('rect');
    r.setAttribute('x', x);  r.setAttribute('y', y);
    r.setAttribute('width',  Math.max(0, w));
    r.setAttribute('height', Math.max(0, h));
    for (const [k, v] of Object.entries(opts || {})) r.setAttribute(k, v);
    parent.appendChild(r);
    return r;
  }

  _panelLabel(vp, x, y, text) {
    const t = this._el('text');
    this._attrs(t, { x, y, fill: '#a855f7', 'font-size': 10,
                     'font-weight': 'bold', 'letter-spacing': 1 });
    t.textContent = text;
    vp.appendChild(t);
  }

  _hint(vp, x, y, text) {
    const t = this._el('text');
    this._attrs(t, { x, y, fill: '#253040', 'font-size': 13, 'text-anchor': 'middle' });
    t.textContent = text;
    vp.appendChild(t);
  }

  /* ---- Hide / Unhide paragons in DM pane ---- */

  _showHideModal() {
    const dm = this.app.project.model.dependencyModels[this.selectedDMId];
    if (!dm) return;
    const visible = Object.values(dm.paragons).filter(p => !this._hiddenParIds.has(p.id));
    if (visible.length === 0) { this.app.setStatus('No visible paragons to hide.'); return; }

    const items = visible.map(p =>
      `<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;cursor:pointer">
         <input type="checkbox" value="${this.app._esc(p.id)}">
         <span>${this.app._esc(p.description)}</span>
         <span style="color:#5a6880;font-size:10px">(${p.type})</span>
       </label>`
    ).join('');

    this.app.showModal('Hide Paragons from Impact View',
      `<p style="font-size:11px;color:#8899b0;margin-bottom:8px">
         Tick paragons to hide from the DM pane. They remain in the model.
       </p>
       <div style="max-height:280px;overflow-y:auto">${items}</div>`,
      () => {
        const checked = document.querySelectorAll('#modal-body input[type=checkbox]:checked');
        let changed = false;
        for (const cb of checked) { this._hiddenParIds.add(cb.value); changed = true; }
        if (changed) { this._dmZoom = null; this.render(); }
      }
    );
  }

  _showUnhideModal() {
    if (this._hiddenParIds.size === 0) { this.app.setStatus('No hidden paragons.'); return; }
    const dm = this.app.project.model.dependencyModels[this.selectedDMId];
    if (!dm) return;

    const items = [...this._hiddenParIds].map(id => {
      const p = dm.paragons[id];
      const label = p ? p.description : id;
      const type  = p ? p.type : '';
      return `<label style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;cursor:pointer">
                <input type="checkbox" value="${this.app._esc(id)}" checked>
                <span>${this.app._esc(label)}</span>
                <span style="color:#5a6880;font-size:10px">(${type})</span>
              </label>`;
    }).join('');

    this.app.showModal('Unhide Paragons',
      `<p style="font-size:11px;color:#8899b0;margin-bottom:8px">
         Tick hidden paragons to restore them to the DM pane.
       </p>
       <div style="max-height:280px;overflow-y:auto">${items}</div>`,
      () => {
        const checked = document.querySelectorAll('#modal-body input[type=checkbox]:checked');
        let changed = false;
        for (const cb of checked) { this._hiddenParIds.delete(cb.value); changed = true; }
        if (changed) { this._dmZoom = null; this.render(); }
      }
    );
  }

  _trunc(s, n) {
    if (!s) return '';
    n = Math.max(5, Math.floor(n));
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }
}
