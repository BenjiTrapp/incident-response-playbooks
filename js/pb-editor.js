'use strict';
/* ============================================================
 * RaccoonIR Playbook Process Editor
 * SVG-based interactive editor for RaccoonIR PlaybookProcess diagrams.
 *
 * Visual design:
 *   - Activities: rounded rectangles, color-coded by status
 *   - Sub-process containers: large boxes containing child activities
 *   - Connections (ArtifactStateInstance flow): arrows between activities
 *   - Breadcrumb navigation for hierarchical drill-down
 *
 * Flow model:
 *   Each arrow represents an ArtifactStateInstance.
 *   originatingActivity -> usedByActivity
 *   The artifact name and state name are displayed on the arrow label.
 * ============================================================ */

class PBEditor {
  constructor(svgEl, breadcrumbEl, app) {
    this.svg = svgEl;
    this.breadcrumb = breadcrumbEl;
    this.app = app;
    this.viewport = svgEl.querySelector('#pb-viewport');

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

    // Connection drawing state
    this.isConnecting = false;
    this.connectFromId = null;
    this.tempLine = null;

    this.selectedId = null;
    this.selectedType = null; // 'process' | 'connection'

    // Current process being viewed (root of current view)
    this.currentProcessId = null;
    this.project = null;

    // Navigation stack
    this.navStack = [];  // array of process IDs

    this._bindEvents();
  }

  /* ---- API ---- */

  setProject(project) {
    this.project = project;
  }

  setProcess(processId) {
    if (!this.project) return;
    const proc = this.project.model.processes[processId];
    if (!proc) return;

    this.currentProcessId = processId;

    // Ensure view exists
    if (!this.project.representation.pbViews[processId]) {
      this.project.representation.pbViews[processId] = createPBView();
    }

    const view = this.project.representation.pbViews[processId];
    this.zoom = view.zoom || 1;
    this.panX = view.panX || 0;
    this.panY = view.panY || 0;

    this.selectedId = null;
    this.selectedType = null;
    this._renderBreadcrumb();
    this.render();
  }

  drillDown(processId) {
    if (!this.project || !this.project.model.processes[processId]) return;
    if (this.currentProcessId) this.navStack.push(this.currentProcessId);
    this.setProcess(processId);
  }

  navigateUp() {
    const prev = this.navStack.pop();
    if (prev) this.setProcess(prev);
  }

  getSelectedId() { return this.selectedId; }
  getSelectedType() { return this.selectedType; }

  selectProcess(id) {
    this.selectedId = id;
    this.selectedType = id ? 'process' : null;
    this.render();
    if (id && this.project) {
      const proc = this.project.model.processes[id];
      if (proc) this.app.onPBNodeSelected(proc);
    }
  }

  selectConnection(id) {
    this.selectedId = id;
    this.selectedType = 'connection';
    this.render();
    if (id && this.project) {
      const inst = this.project.model.artifactStateInstances[id];
      if (inst) this.app.onPBConnectionSelected(inst);
    }
  }

  /* ---- Rendering ---- */

  render() {
    if (!this.viewport) return;
    while (this.viewport.firstChild) this.viewport.removeChild(this.viewport.firstChild);

    if (!this.currentProcessId || !this.project) {
      this._renderEmpty();
      return;
    }

    const proc = this.project.model.processes[this.currentProcessId];
    if (!proc) { this._renderEmpty(); return; }

    this._ensureLayout(proc);
    this._applyTransform();
    this._renderConnections(proc);
    this._renderActivities(proc);
  }

  _renderEmpty() {
    const rect = this.svg.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const t = this._svgEl('text');
    t.setAttribute('x', cx); t.setAttribute('y', cy);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', '#5a6880'); t.setAttribute('font-size', '14');
    t.textContent = 'No playbook selected. Use Model Explorer to select or create one.';
    this.viewport.appendChild(t);
  }

  _ensureLayout(proc) {
    const view = this.project.representation.pbViews[this.currentProcessId];
    if (!view.nodePositions) view.nodePositions = {};

    // Auto-layout for sub-processes without positions
    const needsLayout = proc.subProcessIds.some(id => !view.nodePositions[id]);
    if (needsLayout && proc.subProcessIds.length > 0) {
      this._autoLayout(proc, view);
    }
  }

  _applyTransform() {
    this.viewport.setAttribute('transform',
      `translate(${this.panX},${this.panY}) scale(${this.zoom})`);
  }

  _renderConnections(proc) {
    const view = this.project.representation.pbViews[this.currentProcessId];
    const g = this._svgEl('g');
    g.setAttribute('class', 'pb-connections');

    // Get all ArtifactStateInstances connecting activities in this view
    const subSet = new Set(proc.subProcessIds);
    const NW = 160, NH = 60;

    for (const inst of Object.values(this.project.model.artifactStateInstances)) {
      const from = inst.originatingActivity;
      const to = inst.usedByActivity;

      // Only show edges where both endpoints are in this view
      if (!from || !to) continue;
      if (!subSet.has(from) || !subSet.has(to)) continue;

      const pos1 = view.nodePositions[from] || { x: 0, y: 0 };
      const pos2 = view.nodePositions[to] || { x: 0, y: 0 };

      // Connect right-center of source to left-center of target
      const x1 = pos1.x + NW, y1 = pos1.y + NH / 2;
      const x2 = pos2.x, y2 = pos2.y + NH / 2;
      const mx = (x1 + x2) / 2;

      const isSelected = this.selectedId === inst.id;
      const isAchieved = this._isConnectionAchieved(inst);
      const strokeColor = isSelected ? '#c084fc' : (isAchieved ? '#2ecc71' : '#a855f7');

      const path = this._svgEl('path');
      path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', strokeColor);
      path.setAttribute('stroke-width', isSelected ? '2.5' : '1.5');
      path.setAttribute('marker-end', 'url(#pb-arrow)');
      path.setAttribute('data-conn-id', inst.id);
      path.style.cursor = 'pointer';

      g.appendChild(path);

      // Label (artifact name :: state name)
      const label = this._getConnectionLabel(inst);
      if (label) {
        const lt = this._svgEl('text');
        lt.setAttribute('x', mx); lt.setAttribute('y', (y1 + y2) / 2 - 4);
        lt.setAttribute('text-anchor', 'middle');
        lt.setAttribute('font-size', '9');
        lt.setAttribute('fill', isAchieved ? '#27ae60' : '#6a8aaa');
        lt.setAttribute('pointer-events', 'none');
        lt.textContent = label.length > 20 ? label.substring(0, 18) + '…' : label;
        g.appendChild(lt);
      }
    }

    this.viewport.appendChild(g);
  }

  _getConnectionLabel(inst) {
    // Find the artifact state that contains this instance
    for (const art of Object.values(this.project.model.artifacts)) {
      for (const stateId of art.stateIds) {
        const state = this.project.model.artifactStates[stateId];
        if (state && state.instanceIds.includes(inst.id)) {
          const artName = art.name !== 'undefined' ? art.name : '';
          const stateName = state.name !== 'undefined' ? state.name : '';
          if (artName && stateName) return `${artName}::${stateName}`;
          if (artName) return artName;
          if (stateName) return stateName;
        }
      }
    }
    return '';
  }

  _isConnectionAchieved(inst) {
    for (const art of Object.values(this.project.model.artifacts)) {
      for (const stateId of art.stateIds) {
        const state = this.project.model.artifactStates[stateId];
        if (state && state.instanceIds.includes(inst.id)) {
          return state.achievedStatus === true;
        }
      }
    }
    return false;
  }

  _renderActivities(proc) {
    const view = this.project.representation.pbViews[this.currentProcessId];
    const g = this._svgEl('g');
    g.setAttribute('class', 'pb-activities');

    for (const subId of proc.subProcessIds) {
      const sub = this.project.model.processes[subId];
      if (!sub) continue;
      const pos = view.nodePositions[subId] || { x: 0, y: 0 };
      g.appendChild(this._buildActivity(sub, pos.x, pos.y));
    }

    this.viewport.appendChild(g);
  }

  _buildActivity(proc, x, y) {
    const W = 160, H = 60;
    const isSelected   = proc.id === this.selectedId;
    const isCompleted  = proc.status === STATUS_ENUM.COMPLETED;
    const hasChildren  = (proc.subProcessIds || []).length > 0;

    const g = this._svgEl('g');
    g.setAttribute('data-id', proc.id);
    g.setAttribute('transform', `translate(${x},${y})`);
    g.style.cursor = 'pointer';

    // Body — composite activities get a slightly different background tint
    const rect = this._svgEl('rect');
    rect.setAttribute('width', W); rect.setAttribute('height', H);
    rect.setAttribute('rx', 4); rect.setAttribute('ry', 4);
    rect.setAttribute('fill', isCompleted ? '#0d2618' : (hasChildren ? '#161f38' : '#1d2740'));
    rect.setAttribute('stroke', isSelected ? '#c084fc' : (isCompleted ? '#2ecc71' : (hasChildren ? '#546e7a' : '#a855f7')));
    rect.setAttribute('stroke-width', isSelected ? '2' : '1.5');
    g.appendChild(rect);

    // Status bar (top edge)
    const statusBar = this._svgEl('rect');
    statusBar.setAttribute('x', 0); statusBar.setAttribute('y', 0);
    statusBar.setAttribute('width', W); statusBar.setAttribute('height', 3);
    statusBar.setAttribute('rx', 2);
    statusBar.setAttribute('fill', isCompleted ? '#2ecc71' : this._statusColor(proc));
    g.appendChild(statusBar);

    // Name label
    const label = this._svgEl('text');
    label.setAttribute('x', W / 2); label.setAttribute('y', 26);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '11');
    label.setAttribute('fill', '#c8d8f0');
    label.setAttribute('pointer-events', 'none');
    const name = proc.name || 'Activity';
    label.textContent = name.length > 22 ? name.substring(0, 20) + '…' : name;
    g.appendChild(label);

    // Sub-labels (objectives, action type)
    const subInfo = this._getSubLabel(proc);
    if (subInfo) {
      const sub = this._svgEl('text');
      sub.setAttribute('x', W / 2); sub.setAttribute('y', 39);
      sub.setAttribute('text-anchor', 'middle');
      sub.setAttribute('font-size', '9');
      sub.setAttribute('fill', '#6a8aaa');
      sub.setAttribute('pointer-events', 'none');
      sub.textContent = subInfo;
      g.appendChild(sub);
    }

    // Action type indicator (bottom-right)
    const atColor = { MANUAL: '#546e7a', AUTOMATIC: '#1565c0', DUAL: '#6a1b9a', UNKNOWN: '#4e342e' };
    const atBadge = this._svgEl('text');
    atBadge.setAttribute('x', W - 5); atBadge.setAttribute('y', H - 4);
    atBadge.setAttribute('text-anchor', 'end');
    atBadge.setAttribute('font-size', '8');
    atBadge.setAttribute('fill', atColor[proc.actionType] || '#546e7a');
    atBadge.setAttribute('pointer-events', 'none');
    atBadge.textContent = proc.actionType ? proc.actionType[0] : 'M';
    g.appendChild(atBadge);

    // Link to paragon indicator
    if (proc.paragonId) {
      const linkDot = this._svgEl('circle');
      linkDot.setAttribute('cx', W - 8); linkDot.setAttribute('cy', 8);
      linkDot.setAttribute('r', 3); linkDot.setAttribute('fill', '#f39c12');
      linkDot.setAttribute('pointer-events', 'none');
      g.appendChild(linkDot);
    }

    // Drill-down indicator for composite activities (double-click to enter)
    if (hasChildren) {
      const childCount = proc.subProcessIds.length;
      const badge = this._svgEl('text');
      badge.setAttribute('x', 8); badge.setAttribute('y', H - 4);
      badge.setAttribute('font-size', '9'); badge.setAttribute('fill', '#546e7a');
      badge.setAttribute('pointer-events', 'none');
      badge.textContent = `▶ ${childCount} sub-activit${childCount === 1 ? 'y' : 'ies'}`;
      g.appendChild(badge);
    }

    // Output port (right center) - for connection drawing
    const outPort = this._svgEl('circle');
    outPort.setAttribute('cx', W); outPort.setAttribute('cy', H / 2);
    outPort.setAttribute('r', 6); outPort.setAttribute('fill', 'rgba(77,126,255,0.3)');
    outPort.setAttribute('stroke', '#a855f7'); outPort.setAttribute('stroke-width', '1.5');
    outPort.setAttribute('class', 'pb-out-port');
    outPort.setAttribute('data-port', 'out');
    outPort.setAttribute('data-from-id', proc.id);
    outPort.style.cursor = 'crosshair';
    const portTitle = this._svgEl('title');
    portTitle.textContent = 'Drag to connect to another activity (creates a flow arrow)';
    outPort.appendChild(portTitle);
    g.appendChild(outPort);

    // Hit area
    const hit = this._svgEl('rect');
    hit.setAttribute('width', W); hit.setAttribute('height', H);
    hit.setAttribute('fill', 'transparent');
    hit.setAttribute('data-id', proc.id);
    g.appendChild(hit);

    return g;
  }

  _statusColor(proc) {
    const objColors = {
      INVESTIGATION: '#1565c0',
      MITIGATION: '#e65100',
      REMEDIATION: '#2e7d32',
      PREVENTION: '#6a1b9a'
    };
    if (proc.objectives && proc.objectives.length > 0) {
      return objColors[proc.objectives[0]] || '#37474f';
    }
    return '#37474f';
  }

  _getSubLabel(proc) {
    const parts = [];
    if (proc.objectives && proc.objectives.length > 0) {
      parts.push(proc.objectives.map(o => o[0]).join('/'));
    }
    if (proc.associatedRoleIds && proc.associatedRoleIds.length > 0) {
      const role = Registry.getRole(this.project, proc.associatedRoleIds[0]);
      if (role) parts.push(role.name);
    }
    return parts.join(' · ');
  }

  /* ---- Auto Layout ---- */

  _autoLayout(proc, view) {
    const NW = 160, NH = 60;
    const HGAP = 50, VGAP = 80;
    const COLS = Math.ceil(Math.sqrt(proc.subProcessIds.length));

    // Build a simple topological/grid layout
    // Try to order by connection dependencies
    const ordered = this._topoSort(proc);

    let col = 0, row = 0;
    for (const id of ordered) {
      view.nodePositions[id] = {
        x: 60 + col * (NW + HGAP),
        y: 60 + row * (NH + VGAP)
      };
      col++;
      if (col >= COLS) { col = 0; row++; }
    }
  }

  _topoSort(proc) {
    // Simple topological sort based on artifact state instance connections
    const subSet = new Set(proc.subProcessIds);
    const inDegree = {};
    const adj = {};  // id -> [successors]

    for (const id of proc.subProcessIds) {
      inDegree[id] = 0;
      adj[id] = [];
    }

    for (const inst of Object.values(this.project.model.artifactStateInstances)) {
      if (subSet.has(inst.originatingActivity) && subSet.has(inst.usedByActivity)) {
        if (!adj[inst.originatingActivity].includes(inst.usedByActivity)) {
          adj[inst.originatingActivity].push(inst.usedByActivity);
          inDegree[inst.usedByActivity]++;
        }
      }
    }

    // Kahn's algorithm
    const queue = proc.subProcessIds.filter(id => inDegree[id] === 0);
    const sorted = [];
    while (queue.length) {
      const id = queue.shift();
      sorted.push(id);
      for (const next of (adj[id] || [])) {
        inDegree[next]--;
        if (inDegree[next] === 0) queue.push(next);
      }
    }

    // Add any remaining (in case of cycle or disconnected)
    for (const id of proc.subProcessIds) {
      if (!sorted.includes(id)) sorted.push(id);
    }

    return sorted;
  }

  /* ---- Breadcrumb ---- */

  _renderBreadcrumb() {
    if (!this.breadcrumb || !this.project) return;
    this.breadcrumb.innerHTML = '';

    const rootLabel = document.createElement('span');
    rootLabel.textContent = 'Playbooks';
    rootLabel.className = 'bc-item';
    rootLabel.addEventListener('click', () => {
      this.navStack = [];
      this.currentProcessId = null;
      this.render();
      this._renderBreadcrumb();
    });
    this.breadcrumb.appendChild(rootLabel);

    // Build chain: navStack + currentProcess
    const chain = [...this.navStack];
    if (this.currentProcessId) chain.push(this.currentProcessId);

    for (let i = 0; i < chain.length; i++) {
      const sep = document.createElement('span');
      sep.textContent = ' › ';
      sep.className = 'bc-sep';
      this.breadcrumb.appendChild(sep);

      const proc = this.project.model.processes[chain[i]];
      const item = document.createElement('span');
      item.textContent = proc ? proc.name : chain[i];
      item.className = 'bc-item';
      const idx = i;
      item.addEventListener('click', () => {
        if (idx === chain.length - 1) return;
        this.navStack = chain.slice(0, idx);
        this.setProcess(chain[idx]);
      });
      this.breadcrumb.appendChild(item);
    }
  }

  /* ---- Event Binding ---- */

  _bindEvents() {
    this.svg.addEventListener('mousedown', e => this._onMouseDown(e));
    this.svg.addEventListener('mousemove', e => this._onMouseMove(e));
    this.svg.addEventListener('mouseup',   e => this._onMouseUp(e));
    this.svg.addEventListener('wheel',     e => this._onWheel(e), { passive: false });
    this.svg.addEventListener('contextmenu', e => this._onContextMenu(e));
    this.svg.addEventListener('dblclick',  e => this._onDblClick(e));
  }

  _onMouseDown(e) {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this.isPanning = true;
      this.panStartX = e.clientX - this.panX;
      this.panStartY = e.clientY - this.panY;
      this.svg.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    // Check if clicked on an output port
    let el = e.target;
    while (el && el !== this.svg) {
      if (el.getAttribute('data-port') === 'out') {
        const fromId = el.getAttribute('data-from-id');
        if (fromId) {
          this.isConnecting = true;
          this.connectFromId = fromId;
          e.preventDefault();
          return;
        }
      }
      el = el.parentElement;
    }

    // Check connection click
    const connId = this._getConnectionAt(e);
    if (connId) {
      this.selectConnection(connId);
      return;
    }

    const nodeId = this._getNodeIdAt(e);
    if (nodeId) {
      e.preventDefault();
      this.selectProcess(nodeId);
      const view = this.project && this.project.representation.pbViews[this.currentProcessId];
      if (view) {
        const pos = view.nodePositions[nodeId] || { x: 0, y: 0 };
        this.isDragging = true;
        this.dragNodeId = nodeId;
        const svgPt = this._toSVGCoords(e);
        this.dragStartX = svgPt.x;
        this.dragStartY = svgPt.y;
        this.dragNodeStartX = pos.x;
        this.dragNodeStartY = pos.y;
      }
    } else {
      this.isPanning = true;
      this.panStartX = e.clientX - this.panX;
      this.panStartY = e.clientY - this.panY;
      this.svg.style.cursor = 'grabbing';
      this.selectedId = null;
      this.selectedType = null;
      this.render();
      this.app.onPBNodeSelected(null);
    }
  }

  _onMouseMove(e) {
    if (this.isPanning) {
      this.panX = e.clientX - this.panStartX;
      this.panY = e.clientY - this.panStartY;
      const view = this.project && this.project.representation.pbViews[this.currentProcessId];
      if (view) { view.panX = this.panX; view.panY = this.panY; }
      this._applyTransform();
      return;
    }
    if (this.isDragging && this.dragNodeId) {
      const svgPt = this._toSVGCoords(e);
      const dx = svgPt.x - this.dragStartX;
      const dy = svgPt.y - this.dragStartY;
      const view = this.project.representation.pbViews[this.currentProcessId];
      if (view) {
        view.nodePositions[this.dragNodeId] = {
          x: this.dragNodeStartX + dx,
          y: this.dragNodeStartY + dy
        };
        this.render();
      }
    }
    if (this.isConnecting) {
      // Draw temp connection line
      this.render();
      const svgPt = this._toSVGCoords(e);
      const view = this.project.representation.pbViews[this.currentProcessId];
      const fromPos = view && view.nodePositions[this.connectFromId];
      if (fromPos) {
        const line = this._svgEl('line');
        line.setAttribute('x1', fromPos.x + 160);
        line.setAttribute('y1', fromPos.y + 30);
        line.setAttribute('x2', svgPt.x);
        line.setAttribute('y2', svgPt.y);
        line.setAttribute('stroke', '#a855f7');
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('stroke-dasharray', '6,3');
        line.setAttribute('fill', 'none');
        line.setAttribute('pointer-events', 'none');
        this.viewport.appendChild(line);
      }
    }
    const pt = this._toSVGCoords(e);
    this.app.updateCoords(Math.round(pt.x), Math.round(pt.y));
  }

  _onMouseUp(e) {
    if (this.isConnecting) {
      const toId = this._getNodeIdAt(e);
      if (toId && toId !== this.connectFromId) {
        this.app.createConnection(this.connectFromId, toId, this.currentProcessId);
      }
      this.isConnecting = false;
      this.connectFromId = null;
      this.render();
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
    const view = this.project && this.project.representation.pbViews[this.currentProcessId];
    if (view) { view.zoom = this.zoom; view.panX = this.panX; view.panY = this.panY; }
    this._applyTransform();
    this.app.updateZoom(this.zoom);
  }

  _onContextMenu(e) {
    e.preventDefault();
    const nodeId = this._getNodeIdAt(e);
    const connId = this._getConnectionAt(e);
    this.app.showPBContextMenu(e, nodeId, connId, this.currentProcessId);
  }

  _onDblClick(e) {
    const nodeId = this._getNodeIdAt(e);
    if (nodeId) {
      const proc = this.project && this.project.model.processes[nodeId];
      if (proc && proc.subProcessIds.length > 0) {
        this.drillDown(nodeId);
      } else if (proc) {
        this.app.editProcessInline(nodeId);
      }
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

  _getConnectionAt(e) {
    let el = e.target;
    while (el && el !== this.svg) {
      const id = el.getAttribute('data-conn-id');
      if (id) return id;
      el = el.parentElement;
    }
    return null;
  }

  _toSVGCoords(e) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this.panX) / this.zoom,
      y: (e.clientY - rect.top  - this.panY) / this.zoom
    };
  }

  _svgEl(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  resetView() {
    this.zoom = 1; this.panX = 40; this.panY = 40;
    const view = this.project && this.project.representation.pbViews[this.currentProcessId];
    if (view) { view.zoom = 1; view.panX = 40; view.panY = 40; }
    this._applyTransform();
    this.app.updateZoom(1);
  }

  fitView() {
    if (!this.currentProcessId || !this.project) return;
    const view = this.project.representation.pbViews[this.currentProcessId];
    if (!view) return;
    const positions = Object.values(view.nodePositions);
    if (positions.length === 0) return;
    const W = 160, H = 60;
    const minX = Math.min(...positions.map(p => p.x));
    const minY = Math.min(...positions.map(p => p.y));
    const maxX = Math.max(...positions.map(p => p.x)) + W;
    const maxY = Math.max(...positions.map(p => p.y)) + H;
    const rect = this.svg.getBoundingClientRect();
    const scaleX = (rect.width - 80) / (maxX - minX || 1);
    const scaleY = (rect.height - 80) / (maxY - minY || 1);
    this.zoom = Math.min(scaleX, scaleY, 2);
    this.panX = (rect.width - (maxX - minX) * this.zoom) / 2 - minX * this.zoom;
    this.panY = (rect.height - (maxY - minY) * this.zoom) / 2 - minY * this.zoom;
    if (view) { view.zoom = this.zoom; view.panX = this.panX; view.panY = this.panY; }
    this._applyTransform();
    this.app.updateZoom(this.zoom);
  }
}
