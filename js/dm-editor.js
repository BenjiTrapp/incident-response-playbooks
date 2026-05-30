'use strict';
/* ============================================================
 * RaccoonIR Dependency Model Editor
 * SVG-based interactive editor for the Paragon dependency tree.
 *
 * Visual design:
 *   - Nodes: rounded rectangles with description text, probability
 *     gauge bar, and type badge (AND/OR/UNCONTROLLABLE)
 *   - Edges: lines from parent to child with different styles
 *     AND=solid, OR=dashed, UNCONTROLLABLE=dotted
 *   - AND gate edges have filled diamond source arrow
 *   - OR gate edges have open diamond source arrow
 * ============================================================ */

class DMEditor {
  constructor(svgEl, app) {
    this.svg = svgEl;
    this.app = app;
    this.viewport = svgEl.querySelector('#dm-viewport');

    // View state
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    // Interaction state
    this.isDragging = false;
    this.dragNodeId = null;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragNodeStartX = 0;
    this.dragNodeStartY = 0;
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;

    this.selectedId = null;

    // Current DM and its view data
    this.dm = null;
    this.view = null;

    // Impact simulation state
    this.impactOverrides = {};       // paragonId -> overridden probability
    this.impactedParagonIds = new Set(); // paragonIds directly impacted by activities

    // Expand/collapse state — paragonIds whose children are hidden
    this._collapsed = new Set();

    // Drag-to-connect state
    this._connectFromId = null;  // paragonId being dragged from

    this._bindEvents();
  }

  /* ---- API ---- */

  setDM(dm, view) {
    this.dm = dm;
    this.view = view;
    this.zoom = view.zoom || 1;
    this.panX = view.panX || 0;
    this.panY = view.panY || 0;
    this.selectedId = null;
    this.impactOverrides = {};
    this.impactedParagonIds = new Set();
    this._collapsed = new Set();
    this._connectFromId = null;
    this.render();
  }

  setImpactSimulation(overrides, impactedIds) {
    this.impactOverrides = overrides || {};
    this.impactedParagonIds = impactedIds || new Set();
    this.render();
  }

  clearImpactSimulation() {
    this.impactOverrides = {};
    this.impactedParagonIds = new Set();
    this.render();
  }

  getSelectedId() { return this.selectedId; }

  selectNode(id) {
    this.selectedId = id;
    this.render();
    if (id && this.dm && this.dm.paragons[id]) {
      this.app.onDMNodeSelected(this.dm.paragons[id], this.dm);
    }
  }

  /* ---- Rendering ---- */

  render() {
    if (!this.viewport) return;
    // Clear viewport
    while (this.viewport.firstChild) this.viewport.removeChild(this.viewport.firstChild);

    if (!this.dm) {
      this._renderEmpty();
      return;
    }

    // Ensure layout positions exist
    this._ensureLayout();

    // Update transform
    this._applyTransform();

    // Draw edges first (behind nodes)
    this._renderEdges();

    // Draw nodes
    this._renderNodes();
  }

  _renderEmpty() {
    const rect = this.svg.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const g = this._svgEl('g');
    const t = this._svgEl('text');
    t.setAttribute('x', cx); t.setAttribute('y', cy);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', '#5a6880'); t.setAttribute('font-size', '14');
    t.textContent = 'No dependency model selected. Use Model Explorer to select or create one.';
    g.appendChild(t);
    this.viewport.appendChild(g);
  }

  _ensureLayout() {
    if (!this.view.nodePositions) this.view.nodePositions = {};
    // Full auto-layout when no positions exist at all
    const hasPositions = Object.keys(this.view.nodePositions).length > 0;
    if (!hasPositions) { this.autoLayout(); return; }
    // Assign fallback positions for any paragons added since the last full layout
    const positioned = new Set(Object.keys(this.view.nodePositions));
    const unplaced = Object.keys(this.dm.paragons).filter(id => !positioned.has(id));
    if (unplaced.length > 0) {
      const all = Object.values(this.view.nodePositions);
      const maxX = all.length ? Math.max(...all.map(p => p.x)) + 190 : 40;
      const midY = all.length ? all.reduce((s, p) => s + p.y, 0) / all.length : 40;
      unplaced.forEach((id, i) => {
        this.view.nodePositions[id] = { x: maxX + i * 190, y: Math.round(midY) };
      });
    }
  }

  _applyTransform() {
    this.viewport.setAttribute('transform',
      `translate(${this.panX},${this.panY}) scale(${this.zoom})`);
  }

  /** Returns IDs of all parentless paragons (roots of their subtrees, incl. standalone). */
  _rootIds() {
    const childSet = new Set();
    for (const p of Object.values(this.dm.paragons)) for (const c of p.childIds) childSet.add(c);
    const roots = Object.keys(this.dm.paragons).filter(id => !childSet.has(id));
    // Primary rootId first
    if (this.dm.rootId && roots.includes(this.dm.rootId)) {
      roots.splice(roots.indexOf(this.dm.rootId), 1);
      roots.unshift(this.dm.rootId);
    }
    return roots;
  }

  _renderEdges() {
    if (!this.dm) return;
    const g = this._svgEl('g');
    g.setAttribute('class', 'dm-edges');

    const visited = new Set();
    const renderEdgesFrom = (paragonId) => {
      if (visited.has(paragonId)) return;
      visited.add(paragonId);
      const p = this.dm.paragons[paragonId];
      if (!p || this._collapsed.has(paragonId)) return;
      for (const childId of p.childIds) {
        const pos1 = this.view.nodePositions[paragonId] || { x: 0, y: 0 };
        const pos2 = this.view.nodePositions[childId] || { x: 0, y: 0 };
        const W = 160, H = 60;
        const x1 = pos1.x + W / 2, y1 = pos1.y + H;
        const x2 = pos2.x + W / 2, y2 = pos2.y;
        const ctrl = Math.max(30, Math.abs(y2 - y1) * 0.45);

        const edge = this._svgEl('path');
        edge.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1+ctrl} ${x2} ${y2-ctrl} ${x2} ${y2}`);
        edge.setAttribute('class', 'dm-edge');

        if (p.type === PARAGON_TYPE.AND) {
          edge.setAttribute('stroke', '#2e7d32'); edge.setAttribute('stroke-width', '1.5');
          edge.setAttribute('fill', 'none'); edge.setAttribute('marker-end', 'url(#dm-arrow)');
        } else if (p.type === PARAGON_TYPE.OR) {
          edge.setAttribute('stroke', '#e65100'); edge.setAttribute('stroke-width', '1.5');
          edge.setAttribute('stroke-dasharray', '5,3');
          edge.setAttribute('fill', 'none'); edge.setAttribute('marker-end', 'url(#dm-arrow-or)');
        } else {
          edge.setAttribute('stroke', '#546e7a'); edge.setAttribute('stroke-width', '1.5');
          edge.setAttribute('stroke-dasharray', '3,3');
          edge.setAttribute('fill', 'none'); edge.setAttribute('marker-end', 'url(#dm-arrow-unc)');
        }

        g.appendChild(edge);
        renderEdgesFrom(childId);
      }
    };

    // Traverse from every root (incl. standalone) — collapse is respected inside renderEdgesFrom
    for (const rid of this._rootIds()) renderEdgesFrom(rid);
    this.viewport.appendChild(g);
  }

  _renderNodes() {
    const g = this._svgEl('g');
    g.setAttribute('class', 'dm-nodes');

    const visited = new Set();
    const renderNode = (paragonId) => {
      if (visited.has(paragonId)) return;
      visited.add(paragonId);
      const p = this.dm.paragons[paragonId];
      if (!p) return;
      const pos = this.view.nodePositions[paragonId] || { x: 0, y: 0 };
      g.appendChild(this._buildNode(p, pos.x, pos.y));
      if (!this._collapsed.has(paragonId)) {
        for (const cid of p.childIds) renderNode(cid);
      }
    };

    // Traverse from every root (incl. standalone) — collapse is respected inside renderNode
    for (const rid of this._rootIds()) renderNode(rid);
    this.viewport.appendChild(g);
  }

  _buildNode(paragon, x, y) {
    const W = 160, H = 60;
    const project = this.app && this.app.project;

    // --- Cross-DM proxy resolution ---
    const isProxy = !!(paragon.proxyDMId && paragon.proxyParagonId);
    let displayDesc  = paragon.description;
    let proxyDMName  = '';
    let proxyMissing = false;
    if (isProxy) {
      const extDM = project && project.model.dependencyModels[paragon.proxyDMId];
      if (extDM) {
        const extPar = extDM.paragons[paragon.proxyParagonId];
        if (extPar) {
          displayDesc = extPar.description;
          proxyDMName = extDM.name;
        } else {
          proxyMissing = true; displayDesc = '⚠ Reference missing';
        }
      } else {
        proxyMissing = true; displayDesc = '⚠ DM not found';
      }
    }

    const prob = Metrics.computeProbability(paragon.id, this.dm.paragons, this.impactOverrides, project);
    const isSelected  = paragon.id === this.selectedId;
    const isLeafLocal = isProxy || paragon.childIds.length === 0;
    const isRoot      = !Object.values(this.dm.paragons).some(p => p.childIds.includes(paragon.id));
    const isImpacted  = this.impactedParagonIds.has(paragon.id);
    const isSimulating = Object.keys(this.impactOverrides).length > 0;
    const origProb    = isSimulating
      ? Metrics.computeProbability(paragon.id, this.dm.paragons, {}, project) : prob;
    const simChanged  = isSimulating && Math.abs(prob - origProb) > 0.0005;

    const g = this._svgEl('g');
    g.setAttribute('class', 'dm-node-wrap');
    g.setAttribute('data-id', paragon.id);
    g.setAttribute('transform', `translate(${x},${y})`);
    g.style.cursor = 'pointer';

    // Node background
    let bgFill;
    if (isProxy) {
      bgFill = proxyMissing ? '#2a0a0a' : '#0d1e30';
    } else {
      bgFill = prob >= 0.7 ? '#0a2e14' : (prob >= 0.4 ? '#2e1e00' : '#2e0a0a');
    }
    let borderColor;
    if (proxyMissing)      borderColor = '#e74c3c';
    else if (isProxy)      borderColor = isSelected ? '#c084fc' : '#4a7a99';
    else if (isSelected)   borderColor = '#c084fc';
    else if (isImpacted)   borderColor = '#ff7043';
    else                   borderColor = Metrics.probToColor(prob);

    const rect = this._svgEl('rect');
    rect.setAttribute('width', W); rect.setAttribute('height', H);
    rect.setAttribute('rx', 5); rect.setAttribute('ry', 5);
    rect.setAttribute('class', 'dm-node-body');
    rect.setAttribute('fill', bgFill);
    rect.setAttribute('stroke', borderColor);
    rect.setAttribute('stroke-width', isSelected ? '2.5' : (isImpacted ? '2' : '1.5'));
    if (isProxy) rect.setAttribute('stroke-dasharray', '5 3');
    g.appendChild(rect);

    // Top-left badge: DM name for proxy, type label otherwise
    const badge = this._svgEl('text');
    badge.setAttribute('x', 6); badge.setAttribute('y', 13);
    badge.setAttribute('font-size', '9'); badge.setAttribute('font-weight', 'bold');
    badge.setAttribute('pointer-events', 'none');
    if (isProxy && !proxyMissing) {
      badge.setAttribute('fill', '#5a98cc');
      const dmLabel = proxyDMName.length > 14 ? proxyDMName.slice(0, 12) + '\u2026' : proxyDMName;
      badge.textContent = '\u2197 ' + dmLabel;
    } else if (!isProxy) {
      const typeColors = { AND: '#66bb6a', OR: '#ffa040', UNCONTROLLABLE: '#78909c' };
      badge.setAttribute('fill', typeColors[paragon.type] || '#78909c');
      badge.textContent = paragon.type;
    }
    g.appendChild(badge);

    // Impact badge (top-right) — non-proxy only
    if (isImpacted && !isProxy) {
      const badgeRect = this._svgEl('rect');
      badgeRect.setAttribute('x', W - 20); badgeRect.setAttribute('y', 2);
      badgeRect.setAttribute('width', 18); badgeRect.setAttribute('height', 13);
      badgeRect.setAttribute('rx', 3); badgeRect.setAttribute('fill', '#e65100');
      badgeRect.setAttribute('pointer-events', 'none');
      g.appendChild(badgeRect);
      const badgeTxt = this._svgEl('text');
      badgeTxt.setAttribute('x', W - 11); badgeTxt.setAttribute('y', 12);
      badgeTxt.setAttribute('text-anchor', 'middle');
      badgeTxt.setAttribute('font-size', '9'); badgeTxt.setAttribute('font-weight', 'bold');
      badgeTxt.setAttribute('fill', '#fff'); badgeTxt.setAttribute('pointer-events', 'none');
      badgeTxt.textContent = '\u25b2';
      g.appendChild(badgeTxt);
    }

    // SVG tooltip
    const svgTitle = this._svgEl('title');
    if (isProxy) {
      svgTitle.textContent = proxyMissing
        ? `Cross-DM reference — original not found\nTarget DM: ${paragon.proxyDMId}`
        : `\u2197 ${displayDesc}\nFrom: ${proxyDMName}\nClick to navigate to original`;
    } else {
      svgTitle.textContent = simChanged
        ? `${displayDesc}\n${Metrics.formatProb(origProb)} \u2192 ${Metrics.formatProb(prob)} (simulated)`
        : displayDesc + (isSimulating ? `\n${Metrics.formatProb(prob)}` : '');
    }
    g.appendChild(svgTitle);

    // Description label
    const label = this._svgEl('text');
    label.setAttribute('x', W / 2); label.setAttribute('y', 30);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', isProxy ? '#6a98b8' : '#c8d8f0');
    label.setAttribute('pointer-events', 'none');
    label.textContent = displayDesc.length > 22 ? displayDesc.substring(0, 20) + '\u2026' : displayDesc;
    g.appendChild(label);

    // Probability gauge bar
    const gaugeX = 8, gaugeY = 42, gaugeW = W - 16, gaugeH = 8;
    const gaugeBg = this._svgEl('rect');
    gaugeBg.setAttribute('x', gaugeX); gaugeBg.setAttribute('y', gaugeY);
    gaugeBg.setAttribute('width', gaugeW); gaugeBg.setAttribute('height', gaugeH);
    gaugeBg.setAttribute('rx', 2); gaugeBg.setAttribute('fill', '#0d1520');
    g.appendChild(gaugeBg);
    const gaugeFill = this._svgEl('rect');
    gaugeFill.setAttribute('x', gaugeX); gaugeFill.setAttribute('y', gaugeY);
    gaugeFill.setAttribute('width', Math.max(2, gaugeW * prob));
    gaugeFill.setAttribute('height', gaugeH);
    gaugeFill.setAttribute('rx', 2);
    gaugeFill.setAttribute('fill', isProxy ? '#4a7a99' : Metrics.probToColor(prob));
    g.appendChild(gaugeFill);
    const probTxt = this._svgEl('text');
    probTxt.setAttribute('x', W - 6); probTxt.setAttribute('y', gaugeY + gaugeH - 1);
    probTxt.setAttribute('text-anchor', 'end');
    probTxt.setAttribute('font-size', '8');
    probTxt.setAttribute('fill', '#8899b0'); probTxt.setAttribute('pointer-events', 'none');
    probTxt.textContent = Metrics.formatProb(prob);
    g.appendChild(probTxt);

    // Leaf dot (local non-proxy leaf)
    if (isLeafLocal && !isProxy) {
      const leafDot = this._svgEl('circle');
      leafDot.setAttribute('cx', W / 2); leafDot.setAttribute('cy', H - 4);
      leafDot.setAttribute('r', 2.5); leafDot.setAttribute('fill', '#546e7a');
      g.appendChild(leafDot);
    }

    // Root indicator — top bar (any parentless node)
    if (isRoot) {
      const topBar = this._svgEl('rect');
      topBar.setAttribute('x', 0); topBar.setAttribute('y', 0);
      topBar.setAttribute('width', W); topBar.setAttribute('height', 3);
      topBar.setAttribute('rx', 2);
      topBar.setAttribute('fill', isProxy ? '#4a7a99' : Metrics.probToColor(prob));
      topBar.setAttribute('pointer-events', 'none');
      g.appendChild(topBar);
    }

    // Hit area
    const hit = this._svgEl('rect');
    hit.setAttribute('width', W); hit.setAttribute('height', H);
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('data-id', paragon.id);
    g.appendChild(hit);

    // Collapse toggle — local non-leaf only (proxy is always a leaf in this DM)
    if (!isLeafLocal) {
      const isCollapsed = this._collapsed.has(paragon.id);
      const childCount  = paragon.childIds.length;
      const toggleBg = this._svgEl('rect');
      toggleBg.setAttribute('x', W / 2 - 18); toggleBg.setAttribute('y', H + 3);
      toggleBg.setAttribute('width', 36);      toggleBg.setAttribute('height', 14);
      toggleBg.setAttribute('rx', 3);
      toggleBg.setAttribute('fill', isCollapsed ? '#1a2e50' : '#0e1a2e');
      toggleBg.setAttribute('stroke', '#2e4a70'); toggleBg.setAttribute('stroke-width', '1');
      toggleBg.setAttribute('data-toggle-id', paragon.id);
      toggleBg.style.cursor = 'pointer';
      g.appendChild(toggleBg);
      const toggleTxt = this._svgEl('text');
      toggleTxt.setAttribute('x', W / 2); toggleTxt.setAttribute('y', H + 13);
      toggleTxt.setAttribute('text-anchor', 'middle');
      toggleTxt.setAttribute('font-size', '9'); toggleTxt.setAttribute('fill', '#6aaeff');
      toggleTxt.setAttribute('pointer-events', 'none');
      toggleTxt.textContent = isCollapsed ? `\u25b6 ${childCount}` : '\u25bc';
      g.appendChild(toggleTxt);
    }

    // Connect port — only for non-proxy nodes
    if (!isProxy) {
      const port = this._svgEl('circle');
      port.setAttribute('cx', W); port.setAttribute('cy', H / 2);
      port.setAttribute('r', '6');
      port.setAttribute('fill', '#1a0a2e'); port.setAttribute('stroke', '#a855f7');
      port.setAttribute('stroke-width', '1.5');
      port.setAttribute('data-connect-from', paragon.id);
      port.style.cursor = 'crosshair';
      const portTitle = this._svgEl('title');
      portTitle.textContent = 'Drag to connect to another node (makes that node a child of this one)';
      port.appendChild(portTitle);
      g.appendChild(port);
    }

    return g;
  }

  /* ---- Auto Layout (recursive tree layout) ---- */

  autoLayout() {
    if (!this.dm) return;
    const positions = {};
    const W = 160, HGAP = 30, VGAP = 90;

    // Find all parentless nodes (roots of their respective subtrees)
    const childSet = new Set();
    for (const p of Object.values(this.dm.paragons)) {
      for (const cid of p.childIds) childSet.add(cid);
    }
    const roots = Object.keys(this.dm.paragons).filter(id => !childSet.has(id));
    // Put dm.rootId first if present
    if (this.dm.rootId && roots.includes(this.dm.rootId)) {
      roots.splice(roots.indexOf(this.dm.rootId), 1);
      roots.unshift(this.dm.rootId);
    }

    // Compute subtree width (shared nodes counted only once per branch)
    const getWidth = (id, visited = new Set()) => {
      if (visited.has(id)) return W + HGAP;
      visited.add(id);
      const p = this.dm.paragons[id];
      if (!p || p.childIds.length === 0) return W + HGAP;
      return p.childIds.reduce((sum, cid) => sum + getWidth(cid, new Set(visited)), 0);
    };

    // Recursively position nodes
    const visited = new Set();
    const layout = (id, x, y) => {
      if (visited.has(id)) return;
      visited.add(id);
      const p = this.dm.paragons[id];
      if (!p) return;
      const totalWidth = getWidth(id);
      positions[id] = { x: x + (totalWidth - W - HGAP) / 2, y };
      let cx = x;
      for (const cid of p.childIds) {
        layout(cid, cx, y + VGAP);
        cx += getWidth(cid);
      }
    };

    // Lay out each subtree side by side with a gap between them
    let offsetX = 40;
    for (const rootId of roots) {
      layout(rootId, offsetX, 40);
      offsetX += getWidth(rootId) + HGAP * 2;
    }

    this.view.nodePositions = positions;
  }

  /* ---- Event Binding ---- */

  _bindEvents() {
    this.svg.addEventListener('mousedown', e => this._onMouseDown(e));
    this.svg.addEventListener('mousemove', e => this._onMouseMove(e));
    this.svg.addEventListener('mouseup',   e => this._onMouseUp(e));
    this.svg.addEventListener('wheel',     e => this._onWheel(e), { passive: false });
    this.svg.addEventListener('contextmenu', e => this._onContextMenu(e));
    this.svg.addEventListener('dblclick',  e => this._onDblClick(e));

    // Drag-and-drop from Model Explorer (paragon items)
    this.svg.addEventListener('dragover', e => {
      // Always prevent default so the drop event fires (DOMStringList lacks .includes in some browsers)
      e.preventDefault();
      e.dataTransfer.dropEffect = 'link';
      this.svg.classList.add('drag-over');
    });
    this.svg.addEventListener('dragleave', e => {
      // Only remove highlight when truly leaving the SVG (not just moving between child elements)
      if (!this.svg.contains(e.relatedTarget)) this.svg.classList.remove('drag-over');
    });
    this.svg.addEventListener('drop', e => {
      this.svg.classList.remove('drag-over');
      const raw = e.dataTransfer.getData('application/raccoon-paragon');
      if (!raw || !this.dm) return;
      e.preventDefault();
      try {
        const { dmId, paragonId } = JSON.parse(raw);
        this.app.dropParagonOnDM(e, dmId, paragonId, this.dm, this);
      } catch (_) { /* malformed data */ }
    });
  }

  _onMouseDown(e) {
    // Collapse toggle — must be checked before node drag/pan handling
    let el = e.target;
    while (el && el !== this.svg) {
      const toggleId = el.getAttribute('data-toggle-id');
      if (toggleId) {
        if (this._collapsed.has(toggleId)) this._collapsed.delete(toggleId);
        else this._collapsed.add(toggleId);
        this.render();
        e.preventDefault();
        return;
      }
      el = el.parentElement;
    }

    // Connect port drag-to-link
    const connectFrom = e.target.getAttribute('data-connect-from');
    if (connectFrom && e.button === 0) {
      this._connectFromId = connectFrom;
      this.svg.style.cursor = 'crosshair';
      e.preventDefault();
      return;
    }

    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this.isPanning = true;
      this.panStartX = e.clientX - this.panX;
      this.panStartY = e.clientY - this.panY;
      this.svg.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const nodeId = this._getNodeIdAt(e);
    if (nodeId) {
      e.preventDefault();
      this.selectNode(nodeId);
      const pos = this.view.nodePositions[nodeId] || { x: 0, y: 0 };
      this.isDragging = true;
      this.dragNodeId = nodeId;
      const svgPt = this._toSVGCoords(e);
      this.dragStartX = svgPt.x;
      this.dragStartY = svgPt.y;
      this.dragNodeStartX = pos.x;
      this.dragNodeStartY = pos.y;
    } else {
      this.isPanning = true;
      this.panStartX = e.clientX - this.panX;
      this.panStartY = e.clientY - this.panY;
      this.svg.style.cursor = 'grabbing';
      this.selectNode(null);
      this.app.onDMNodeSelected(null, this.dm);
    }
  }

  _onMouseMove(e) {
    if (this._connectFromId) {
      // Draw a preview line from the source node port to the cursor
      const fromId = this._connectFromId;
      const fromPos = this.view.nodePositions[fromId] || { x: 0, y: 0 };
      const W = 160, H = 60;
      const svgPt = this._toSVGCoords(e);
      const x1 = fromPos.x + W, y1 = fromPos.y + H / 2;
      const cp = Math.max(20, (svgPt.x - x1) * 0.5);

      let dl = this.viewport.querySelector('#dm-drag-line');
      if (!dl) {
        dl = this._svgEl('path');
        dl.setAttribute('id', 'dm-drag-line');
        dl.setAttribute('fill', 'none');
        dl.setAttribute('stroke', '#a855f7');
        dl.setAttribute('stroke-width', '2');
        dl.setAttribute('stroke-dasharray', '6 3');
        dl.style.pointerEvents = 'none';
        this.viewport.appendChild(dl);
      }
      dl.setAttribute('d', `M${x1},${y1} C${x1+cp},${y1} ${svgPt.x-cp},${svgPt.y} ${svgPt.x},${svgPt.y}`);
      return;
    }
    if (this.isPanning) {
      this.panX = e.clientX - this.panStartX;
      this.panY = e.clientY - this.panStartY;
      if (this.view) { this.view.panX = this.panX; this.view.panY = this.panY; }
      this._applyTransform();
      return;
    }
    if (this.isDragging && this.dragNodeId) {
      const svgPt = this._toSVGCoords(e);
      const dx = svgPt.x - this.dragStartX;
      const dy = svgPt.y - this.dragStartY;
      this.view.nodePositions[this.dragNodeId] = {
        x: this.dragNodeStartX + dx,
        y: this.dragNodeStartY + dy
      };
      this.render();
    }
    const pt = this._toSVGCoords(e);
    this.app.updateCoords(Math.round(pt.x), Math.round(pt.y));
  }

  _onMouseUp(e) {
    // Finish drag-to-connect
    if (this._connectFromId) {
      const fromId = this._connectFromId;
      this._connectFromId = null;
      this.svg.style.cursor = 'default';
      const dl = this.viewport.querySelector('#dm-drag-line');
      if (dl) dl.remove();

      // Find which node the mouse was released on
      const toId = this._getNodeIdAt(e);
      if (toId && toId !== fromId) {
        this.app.dmConnectNodes(fromId, toId, this.dm);
      }
      return;
    }
    this.isDragging = false;
    this.dragNodeId = null;
    this.isPanning = false;
    this.svg.style.cursor = 'default';
  }

  _onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = this.svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    this.panX = mx - (mx - this.panX) * factor;
    this.panY = my - (my - this.panY) * factor;
    this.zoom *= factor;
    this.zoom = Math.max(0.1, Math.min(5, this.zoom));
    if (this.view) { this.view.zoom = this.zoom; this.view.panX = this.panX; this.view.panY = this.panY; }
    this._applyTransform();
    this.app.updateZoom(this.zoom);
  }

  _onContextMenu(e) {
    e.preventDefault();
    const nodeId = this._getNodeIdAt(e);
    this.app.showDMContextMenu(e, nodeId, this.dm);
  }

  _onDblClick(e) {
    const nodeId = this._getNodeIdAt(e);
    if (!nodeId || !this.dm) return;
    const paragon = this.dm.paragons[nodeId];
    if (paragon && paragon.proxyDMId && paragon.proxyParagonId) {
      // Double-click on proxy: navigate to its source DM
      this.app._navigateToProxySource(paragon);
    } else {
      this.app.editParagonInline(nodeId, this.dm);
    }
  }

  /* ---- Helpers ---- */

  _getNodeIdAt(e) {
    let el = e.target;
    while (el && el !== this.svg) {
      const id = el.getAttribute('data-id');
      if (id) return id;
      el = el.parentElement;
    }
    return null;
  }

  _toSVGCoords(e) {
    const rect = this.svg.getBoundingClientRect();
    const x = (e.clientX - rect.left - this.panX) / this.zoom;
    const y = (e.clientY - rect.top  - this.panY) / this.zoom;
    return { x, y };
  }

  _svgEl(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  resetView() {
    this.zoom = 1; this.panX = 40; this.panY = 40;
    if (this.view) { this.view.zoom = 1; this.view.panX = 40; this.view.panY = 40; }
    this._applyTransform();
    this.app.updateZoom(1);
  }

  fitView() {
    if (!this.dm || !this.view) return;
    const positions = Object.values(this.view.nodePositions);
    if (positions.length === 0) return;
    const W = 160, H = 60;
    const minX = Math.min(...positions.map(p => p.x));
    const minY = Math.min(...positions.map(p => p.y));
    const maxX = Math.max(...positions.map(p => p.x)) + W;
    const maxY = Math.max(...positions.map(p => p.y)) + H;
    const rect = this.svg.getBoundingClientRect();
    const svgW = rect.width, svgH = rect.height;
    const scaleX = (svgW - 80) / (maxX - minX);
    const scaleY = (svgH - 80) / (maxY - minY);
    this.zoom = Math.min(scaleX, scaleY, 2);
    this.panX = (svgW - (maxX - minX) * this.zoom) / 2 - minX * this.zoom;
    this.panY = (svgH - (maxY - minY) * this.zoom) / 2 - minY * this.zoom;
    if (this.view) { this.view.zoom = this.zoom; this.view.panX = this.panX; this.view.panY = this.panY; }
    this._applyTransform();
    this.app.updateZoom(this.zoom);
  }
}
