'use strict';
/* ============================================================
 * RaccoonIR Main Application Controller
 * Coordinates all views, panels, and model operations.
 * ============================================================ */

class RaccoonIRApp {
  constructor() {
    this.project = createProject('New Project');
    this.undoStack = [];
    this.redoStack = [];
    this.activeTab = 'dm';  // dm | pb | metrics | symbiosis
    this.isDirty = false;
    this._impactSimActive = false;
    this._criticalThreshold = 0.5;  // CT: default threshold; below this computed probability triggers stakeholder notification
    this._currentFilename = null;   // base filename (no extension) of the last opened/saved file
    this._explorerCollapsed = new Set(); // keys of collapsed explorer nodes
    this._metricsScope = null;      // null = all activities; string = root process ID

    // Editors
    this.dmEditor    = null;
    this.pbEditor    = null;
    this.impactView  = null;

    // UI references
    this.els = {};
  }

  init() {
    this._cacheEls();
    this._initEditors();
    this._initPanelResize();
    this._bindUI();

    // Restore last session from localStorage if available
    const saved = localStorage.getItem('raccoon-ir-autosave');
    if (saved) {
      try {
        this.project = Storage.deserialize(saved);
        this._loadProject();
        this.setStatus(`Restored last session: ${this.project.name}`);
        return;
      } catch (e) {
        console.warn('Could not restore autosave:', e);
      }
    }

    this._renderExplorer();
    this._renderViewToolbar();
    this.setStatus('Ready. Create or open a project to begin.');
  }

  /* ---- Cache DOM elements ---- */

  _cacheEls() {
    const ids = [
      'btn-new','btn-open','btn-save','btn-import','btn-export',
      'btn-undo','btn-redo','file-input',
      'tab-bar','view-toolbar','explorer-content',
      'properties-content','status-message','status-coords',
      'dm-view','pb-view','metrics-view','symbiosis-view','impact-view','mitre-view',
      'dm-canvas','pb-canvas','pb-breadcrumb','impact-canvas',
      'metrics-content','symbiosis-content',
      'modal-overlay','modal-header','modal-body','modal-footer',
      'modal-cancel','modal-ok',
      'context-menu','context-menu-items'
    ];
    for (const id of ids) {
      this.els[id] = document.getElementById(id);
    }
  }

  /* ---- Init Editors ---- */

  _initEditors() {
    if (this.els['dm-canvas']) {
      this.dmEditor = new DMEditor(this.els['dm-canvas'], this);
      // Wrap dmEditor.render so DM operations also refresh the Impact View
      const origDMRender = this.dmEditor.render.bind(this.dmEditor);
      this.dmEditor.render = (...args) => {
        origDMRender(...args);
        if (this.activeTab === 'impact' && this.impactView) {
          this.impactView.render();
        }
      };
    }
    if (this.els['pb-canvas']) {
      this.pbEditor = new PBEditor(this.els['pb-canvas'], this.els['pb-breadcrumb'], this);
      this.pbEditor.setProject(this.project);
    }
    if (this.els['impact-canvas']) {
      this.impactView = new ImpactView(this.els['impact-canvas'], this);
    }
  }

  /* ---- UI Bindings ---- */

  _bindUI() {
    // Header buttons
    this.els['btn-new'].addEventListener('click', () => this._newProject());
    this.els['btn-open'].addEventListener('click', () => this.els['file-input'].click());
    this.els['btn-save'].addEventListener('click', () => this._saveProject());
    this.els['btn-import'].addEventListener('click', () => this._importFile());
    this.els['btn-export'].addEventListener('click', () => this._exportModelOnly());
    this.els['btn-undo'].addEventListener('click', () => this.undo());
    this.els['btn-redo'].addEventListener('click', () => this.redo());

    const helpBtn = document.getElementById('btn-help');
    if (helpBtn) helpBtn.addEventListener('click', () => HelpPanel.open('tutorial'));

    const libraryBtn = document.getElementById('btn-library');
    if (libraryBtn) libraryBtn.addEventListener('click', () => this._openLibrary());

    // File input
    this.els['file-input'].addEventListener('change', e => this._onFileSelected(e));

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
    });

    // Close context menu on click outside
    document.addEventListener('click', e => {
      if (!this.els['context-menu'].contains(e.target)) {
        this.els['context-menu'].classList.add('hidden');
      }
    });

    // Close modal on overlay click
    this.els['modal-overlay'].addEventListener('click', e => {
      if (e.target === this.els['modal-overlay']) this._closeModal();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      const inInput = tag === 'input' || tag === 'textarea' || tag === 'select';

      // Ctrl+Z / Cmd+Z — undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (!inInput) { e.preventDefault(); this.undo(); }
        return;
      }
      // Ctrl+Y / Ctrl+Shift+Z / Cmd+Shift+Z — redo
      if (((e.ctrlKey || e.metaKey) && e.key === 'y') ||
          ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')) {
        if (!inInput) { e.preventDefault(); this.redo(); }
        return;
      }

      // Delete key — remove selected DM node (node only, no descendants)
      if (e.key === 'Delete' && !inInput) {
        if (this.activeTab === 'dm' && this.dmEditor) {
          const nodeId = this.dmEditor.getSelectedId();
          const dm     = this.dmEditor.dm;
          if (nodeId && dm && dm.paragons[nodeId]) {
            this._deleteParagonOnly(nodeId, dm);
          }
        }
      }
    });
  }

  /* ---- Tab Management ---- */

  _switchTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    document.querySelectorAll('.view-panel').forEach(p => {
      p.classList.toggle('active', p.id === tab + '-view');
    });
    this._renderViewToolbar();
    if (tab === 'metrics')  this._renderMetrics();
    if (tab === 'symbiosis') this._renderSymbiosis();
    if (tab === 'impact')   this._renderImpactView();
    if (tab === 'mitre')    this._renderMitreView();
  }

  /* ---- View Toolbar ---- */

  _renderViewToolbar() {
    const tb = this.els['view-toolbar'];
    tb.innerHTML = '';

    if (this.activeTab === 'dm') {
      this._addToolBtn(tb, '+ DM', 'Add Dependency Model', () => this._addDependencyModel());
      this._addToolSep(tb);
      this._addToolBtn(tb, '+ AND', 'Add AND node (child of selected, or standalone if nothing selected)', () => this._addParagonChild(PARAGON_TYPE.AND), 'add-AND');
      this._addToolBtn(tb, '+ OR', 'Add OR node (child of selected, or standalone if nothing selected)', () => this._addParagonChild(PARAGON_TYPE.OR), 'add-OR');
      this._addToolBtn(tb, '+ Leaf', 'Add UNCONTROLLABLE node (child of selected, or standalone if nothing selected)', () => this._addParagonChild(PARAGON_TYPE.UNCONTROLLABLE), 'add-UNC');
      this._addToolSep(tb);
      this._addToolBtn(tb, 'Auto Layout', 'Auto-arrange diagram', () => this._dmAutoLayout());
      this._addToolBtn(tb, 'Fit View', 'Fit all nodes in view', () => this.dmEditor && this.dmEditor.fitView());
      this._addToolBtn(tb, 'Reset View', 'Reset to default view', () => this.dmEditor && this.dmEditor.resetView());
      this._addToolSep(tb);
      const simBtn = this._addToolBtn(tb, 'Simulate Impacts', 'Show effect of all playbook activity impacts on the DM', () => this._toggleImpactSimulation());
      if (this._impactSimActive) simBtn.classList.add('active');
      // Zoom display
      const zd = document.createElement('span');
      zd.id = 'zoom-display';
      zd.className = 'zoom-info';
      zd.textContent = '100%';
      zd.style.marginLeft = 'auto';
      tb.appendChild(zd);
    } else if (this.activeTab === 'pb') {
      this._addToolBtn(tb, '+ Org', 'Add Organisation', () => this._addOrganisation());
      this._addToolBtn(tb, '+ Role', 'Add Role to an organisation', () => this._addRole());
      this._addToolBtn(tb, '+ Playbook', 'Add root playbook process', () => this._addRootProcess());
      this._addToolSep(tb);
      this._addToolBtn(tb, '+ Activity', 'Add sub-activity', () => this._addSubProcess());
      this._addToolBtn(tb, '↑ Up', 'Navigate to parent', () => this.pbEditor && this.pbEditor.navigateUp());
      this._addToolSep(tb);
      this._addToolBtn(tb, 'Auto Layout', 'Auto-arrange diagram', () => this._pbAutoLayout());
      this._addToolBtn(tb, 'Fit View', 'Fit in view', () => this.pbEditor && this.pbEditor.fitView());
      this._addToolBtn(tb, 'Reset View', 'Reset view', () => this.pbEditor && this.pbEditor.resetView());
      const zd = document.createElement('span');
      zd.id = 'zoom-display';
      zd.className = 'zoom-info';
      zd.textContent = '100%';
      zd.style.marginLeft = 'auto';
      tb.appendChild(zd);
    } else if (this.activeTab === 'metrics') {
      this._addToolBtn(tb, 'Refresh', 'Recalculate metrics', () => this._renderMetrics());
      this._addToolSep(tb);
      const scopeLabel = document.createElement('span');
      scopeLabel.className = 'zoom-info';
      scopeLabel.style.cssText = 'margin-left:0;min-width:auto;';
      scopeLabel.textContent = 'CiO scope:';
      tb.appendChild(scopeLabel);
      const scopeSel = document.createElement('select');
      scopeSel.className = 'tool-select';
      scopeSel.title = 'Compute CiO as the probability change caused by this set of activities';
      const allOpt = document.createElement('option');
      allOpt.value = ''; allOpt.textContent = 'All Activities';
      scopeSel.appendChild(allOpt);
      for (const proc of Registry.rootProcesses(this.project)) {
        const opt = document.createElement('option');
        opt.value = proc.id; opt.textContent = proc.name;
        scopeSel.appendChild(opt);
      }
      scopeSel.value = this._metricsScope || '';
      scopeSel.addEventListener('change', () => {
        this._metricsScope = scopeSel.value || null;
        this._renderMetrics();
      });
      tb.appendChild(scopeSel);
    } else if (this.activeTab === 'symbiosis') {
      this._addToolBtn(tb, 'Init SYMBIOSIS', 'Initialise SYMBIOSIS model', () => this._initSymbiosis());
      this._addToolBtn(tb, '+ Business Objective', '', () => this._addBusinessObjective());
      this._addToolBtn(tb, '+ SMG', 'Add Security Measurement Goal', () => this._addSMG());
      this._addToolBtn(tb, '+ Metric', 'Add Security Metric', () => this._addSecurityMetric());
    } else if (this.activeTab === 'impact') {
      this._buildImpactToolbar(tb);
    } else if (this.activeTab === 'mitre') {
      this._addToolBtn(tb, 'Export Navigator Layer', 'Download ATT&CK Navigator layer JSON for this project', () => this._exportNavigatorLayer());
      this._addToolBtn(tb, 'Open ATT&CK Navigator', 'Open MITRE ATT&CK Navigator in a new tab', () => window.open('https://mitre-attack.github.io/attack-navigator/', '_blank'));
      this._addToolSep(tb);
      this._addToolBtn(tb, 'Open D3FEND', 'Open MITRE D3FEND in a new tab', () => window.open('https://d3fend.mitre.org/', '_blank'));
    }
  }

  _addToolBtn(container, label, title, fn, id) {
    const btn = document.createElement('button');
    btn.className = 'tool-btn';
    btn.textContent = label;
    btn.title = title;
    if (id) btn.id = 'tb-' + id;
    btn.addEventListener('click', fn);
    container.appendChild(btn);
    return btn;
  }

  _addToolSep(container) {
    const sep = document.createElement('div');
    sep.className = 'tool-sep';
    container.appendChild(sep);
  }

  /* ---- Model Explorer ---- */

  _renderExplorer() {
    const el = this.els['explorer-content'];
    el.innerHTML = '';

    // Dependency Models section
    const { sec: dmSec, body: dmBody } = this._makeSection('Dependency Models', '🔗', () => this._addDependencyModel(), 'section:dm');
    for (const dm of Object.values(this.project.model.dependencyModels)) {
      const parContainer = document.createElement('div');
      parContainer.className = 'tree-children';
      const childSet = new Set();
      for (const p of Object.values(dm.paragons)) for (const cid of p.childIds) childSet.add(cid);
      const roots = Object.keys(dm.paragons).filter(id => !childSet.has(id));
      if (dm.rootId && roots.includes(dm.rootId)) {
        roots.splice(roots.indexOf(dm.rootId), 1); roots.unshift(dm.rootId);
      }
      for (const rid of roots) this._renderParagonTree(rid, dm.paragons, parContainer, dm.id);
      const { wrap: dmWrap } = this._makeCollapsibleItem('📊', dm.name, `dm:${dm.id}`,
        () => { this._switchTab('dm'); this._selectDM(dm.id); },
        null, parContainer);
      dmBody.appendChild(dmWrap);
    }
    el.appendChild(dmSec);

    // Organisations / Playbooks section
    const { sec: pbSec, body: pbBody } = this._makeSection('Organisations & Playbooks', '🏢', () => this._addOrganisation(), 'section:pb');
    for (const org of Object.values(this.project.model.organisations)) {
      // Roles sub-section
      const rolesContainer = document.createElement('div');
      rolesContainer.className = 'tree-children';
      for (const rid of org.roleIds) {
        const role = this.project.model.roles[rid];
        if (!role) continue;
        rolesContainer.appendChild(this._makeTreeItem('👤', role.name, () => {
          this.showInputModal('Rename Role', 'Role name:', role.name, name => {
            if (!name.trim()) return;
            this._pushUndo(); role.name = name.trim();
            this._renderExplorer(); this._markDirty();
          });
        }));
      }
      const { wrap: rolesWrap } = this._makeCollapsibleItem('👥',
        `Roles (${org.roleIds.length})`, `org-roles:${org.id}`,
        null, () => this._addRole(org.id), rolesContainer);

      // Playbooks sub-section
      const pbsContainer = document.createElement('div');
      pbsContainer.className = 'tree-children';
      for (const pid of org.rootProcessIds) {
        const proc = this.project.model.processes[pid];
        if (!proc) continue;
        const subContainer = document.createElement('div');
        subContainer.className = 'tree-children';
        this._renderProcessTree(proc, subContainer, 0);
        const { wrap: pbWrap } = this._makeCollapsibleItem('▪', proc.name, `pb:${pid}`,
          () => { this._switchTab('pb'); this._selectRootProcess(pid); },
          null, subContainer);
        pbsContainer.appendChild(pbWrap);
      }
      const { wrap: pbsWrap } = this._makeCollapsibleItem('📋',
        `Playbooks (${org.rootProcessIds.length})`, `org-pbs:${org.id}`,
        null, () => this._addRootProcess(org.id), pbsContainer);

      // Org children container
      const orgChildrenEl = document.createElement('div');
      orgChildrenEl.className = 'tree-children';
      orgChildrenEl.appendChild(rolesWrap);
      orgChildrenEl.appendChild(pbsWrap);

      const { wrap: orgWrap } = this._makeCollapsibleItem('🏢', org.name, `org:${org.id}`,
        () => {
          this.showInputModal('Rename Organisation', 'Organisation name:', org.name, name => {
            if (!name.trim()) return;
            this._pushUndo(); org.name = name.trim();
            this._renderExplorer(); this._markDirty();
          });
        }, null, orgChildrenEl);
      pbBody.appendChild(orgWrap);
    }
    el.appendChild(pbSec);

    // SYMBIOSIS section
    if (this.project.model.symbiosis) {
      const { sec: symbSec, body: symbBody } = this._makeSection('SYMBIOSIS', '🔒', null, 'section:symbiosis');
      const s = this.project.model.symbiosis;
      for (const bo of Object.values(s.businessObjectives)) {
        symbBody.appendChild(this._makeTreeItem('🎯', bo.scope || 'Business Objective', null));
      }
      el.appendChild(symbSec);
    }

    // Snapshots section
    const snaps = this.project.snapshots || [];
    if (snaps.length > 0 || this.project.baseline) {
      const { sec: snapSec, body: snapBody } = this._makeSection(
        `Snapshots (${snaps.length})`, '\uD83D\uDCF8', () => this._saveSnapshot(), 'section:snapshots'
      );
      if (this.project.baseline) {
        const resetRow = document.createElement('div');
        resetRow.style.cssText = 'display:flex;align-items:stretch;';
        const resetItem = this._makeTreeItem('\u21A9', 'Reset to Original', () => this._resetToBaseline());
        resetItem.style.cssText = 'flex:1;color:#f39c12;';
        resetItem.title = 'Restore all paragon probabilities and activity statuses to the state before any snapshot was applied';
        resetRow.appendChild(resetItem);
        snapBody.appendChild(resetRow);
      }
      for (const snap of snaps) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:stretch;';
        const snapItem = this._makeTreeItem('\uD83D\uDCF8', snap.label, () => this._renderSnapshotProperties(snap));
        snapItem.style.flex = '1';
        row.appendChild(snapItem);
        const loadBtn = document.createElement('button');
        loadBtn.className = 'panel-add-btn';
        loadBtn.textContent = '\u25B6';
        loadBtn.title = 'Apply this snapshot to the model';
        loadBtn.addEventListener('click', e => { e.stopPropagation(); this._applySnapshot(snap); });
        row.appendChild(loadBtn);
        const delBtn = document.createElement('button');
        delBtn.className = 'panel-add-btn';
        delBtn.textContent = '\uD83D\uDDD1';
        delBtn.title = 'Delete this snapshot';
        delBtn.style.color = '#e74c3c';
        delBtn.addEventListener('click', e => {
          e.stopPropagation();
          this.project.snapshots = this.project.snapshots.filter(s => s.id !== snap.id);
          this._renderExplorer(); this._showNoSelection(); this._markDirty();
          this.setStatus('Snapshot deleted.');
        });
        row.appendChild(delBtn);
        snapBody.appendChild(row);
      }
      el.appendChild(snapSec);
    }
  }

  _renderParagonTree(id, paragons, container, dmId, depth = 0) {
    if (depth > 20) return; // safety
    const p = paragons[id];
    if (!p) return;
    const typeIcon = { AND: '⊕', OR: '⊗', UNCONTROLLABLE: '◆' };
    const item = this._makeTreeItem(typeIcon[p.type] || '◆', p.description, () => {
      this._switchTab('dm');
      if (this.dmEditor) this.dmEditor.selectNode(p.id);
    });
    // Make draggable — allows dropping onto DM canvas nodes to create cross-DM references
    item.draggable = true;
    item.style.cursor = 'grab';
    item.addEventListener('dragstart', e => {
      e.dataTransfer.setData('application/raccoon-paragon', JSON.stringify({ dmId, paragonId: id }));
      e.dataTransfer.effectAllowed = 'link';
      e.stopPropagation();
    });
    container.appendChild(item);
    if (p.childIds.length > 0) {
      const sub = document.createElement('div');
      sub.className = 'tree-children';
      for (const cid of p.childIds) this._renderParagonTree(cid, paragons, sub, dmId, depth + 1);
      container.appendChild(sub);
    }
  }

  _renderProcessTree(proc, container, depth) {
    if (depth > 15) return;
    for (const subId of proc.subProcessIds) {
      const sub = this.project.model.processes[subId];
      if (!sub) continue;
      const item = this._makeTreeItem(sub.subProcessIds.length > 0 ? '📁' : '▪', sub.name, () => {
        this._switchTab('pb');
        this._selectProcessInView(subId);
      });
      container.appendChild(item);
      if (sub.subProcessIds.length > 0) {
        const subCont = document.createElement('div');
        subCont.className = 'tree-children';
        this._renderProcessTree(sub, subCont, depth + 1);
        container.appendChild(subCont);
      }
    }
  }

  _makeSection(title, icon, addFn, key = null) {
    const section = document.createElement('div');
    section.className = 'tree-section';
    const isCollapsed = key ? this._explorerCollapsed.has(key) : false;

    const hdr = document.createElement('div');
    hdr.className = 'tree-section-hdr';
    hdr.innerHTML = `<span class="expand-arrow">${key ? (isCollapsed ? '▶' : '▼') : ''}</span><span style="margin-right:4px">${icon}</span><span style="flex:1">${title}</span>`;
    if (key) {
      hdr.style.cursor = 'pointer';
      hdr.addEventListener('click', e => {
        if (e.target.closest('.panel-add-btn')) return;
        if (this._explorerCollapsed.has(key)) this._explorerCollapsed.delete(key);
        else this._explorerCollapsed.add(key);
        this._renderExplorer();
      });
    }
    if (addFn) {
      const addBtn = document.createElement('button');
      addBtn.className = 'panel-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'Add';
      addBtn.addEventListener('click', e => { e.stopPropagation(); addFn(); });
      hdr.appendChild(addBtn);
    }
    section.appendChild(hdr);

    const body = document.createElement('div');
    if (isCollapsed) body.style.display = 'none';
    section.appendChild(body);

    return { sec: section, body };
  }

  /**
   * A tree item with a ▶/▼ collapse toggle on the left, wrapping a content element.
   * Returns { wrap: outerDiv, content: contentDiv }.
   * @param {string}      icon         Icon character
   * @param {string}      label        Display label
   * @param {string}      key          Collapse key in _explorerCollapsed
   * @param {Function}    onLabelClick Called when the label (not toggle) is clicked
   * @param {Function}    addFn        Optional + button at row right
   * @param {HTMLElement} contentEl    Pre-built content container to show/hide
   */
  _makeCollapsibleItem(icon, label, key, onLabelClick, addFn, contentEl) {
    const isCollapsed = this._explorerCollapsed.has(key);
    const truncated = label && label.length > 100 ? label.slice(0, 100) + '…' : label;

    const wrap = document.createElement('div');

    const item = document.createElement('div');
    item.className = 'tree-item';
    if (label) item.title = label;

    const toggle = document.createElement('span');
    toggle.className = 'ti-toggle';
    toggle.textContent = isCollapsed ? '▶' : '▼';
    toggle.title = isCollapsed ? 'Expand' : 'Collapse';
    toggle.addEventListener('click', e => {
      e.stopPropagation();
      if (this._explorerCollapsed.has(key)) this._explorerCollapsed.delete(key);
      else this._explorerCollapsed.add(key);
      this._renderExplorer();
    });

    const iconSpan = document.createElement('span');
    iconSpan.className = 'ti-icon';
    iconSpan.textContent = icon;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'ti-label';
    labelSpan.textContent = truncated;

    item.appendChild(toggle);
    item.appendChild(iconSpan);
    item.appendChild(labelSpan);

    if (addFn) {
      const addBtn = document.createElement('button');
      addBtn.className = 'panel-add-btn';
      addBtn.textContent = '+';
      addBtn.title = 'Add';
      addBtn.addEventListener('click', e => { e.stopPropagation(); addFn(); });
      item.appendChild(addBtn);
    }

    if (onLabelClick) {
      item.addEventListener('click', e => {
        if (e.target === toggle || e.target.closest('.panel-add-btn')) return;
        onLabelClick();
      });
    }

    if (contentEl) contentEl.style.display = isCollapsed ? 'none' : '';

    wrap.appendChild(item);
    if (contentEl) wrap.appendChild(contentEl);

    return { wrap };
  }

  _makeTreeItem(icon, label, onClick) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    const truncated = label && label.length > 100 ? label.slice(0, 100) + '…' : label;
    item.innerHTML = `<span class="ti-icon">${icon}</span><span class="ti-label">${this._esc(truncated)}</span>`;
    if (label) item.title = label;
    if (onClick) item.addEventListener('click', onClick);
    return item;
  }

  /* ---- Panel Resize ---- */

  _initPanelResize() {
    const MIN_W = 80;
    const storage = { left: 'raccoon-panel-left', right: 'raccoon-panel-right' };

    const explorerEl   = document.getElementById('model-explorer');
    const propertiesEl = document.getElementById('properties-panel');
    const resizerLeft  = document.getElementById('resizer-left');
    const resizerRight = document.getElementById('resizer-right');

    // Restore saved widths
    const savedLeft  = parseInt(localStorage.getItem(storage.left),  10);
    const savedRight = parseInt(localStorage.getItem(storage.right), 10);
    if (savedLeft  && savedLeft  >= MIN_W) explorerEl.style.width   = savedLeft  + 'px';
    if (savedRight && savedRight >= MIN_W) propertiesEl.style.width = savedRight + 'px';

    const startResize = (e, panel, side) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.getBoundingClientRect().width;
      const resizer = side === 'left' ? resizerLeft : resizerRight;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = ev => {
        let newW;
        if (side === 'left') {
          newW = startW + (ev.clientX - startX);
        } else {
          newW = startW - (ev.clientX - startX);
        }
        newW = Math.max(MIN_W, newW);
        panel.style.width = newW + 'px';
      };

      const onUp = ev => {
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const finalW = Math.max(MIN_W, parseInt(panel.style.width, 10) || startW);
        localStorage.setItem(side === 'left' ? storage.left : storage.right, finalW);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    };

    resizerLeft.addEventListener('mousedown',  e => startResize(e, explorerEl,   'left'));
    resizerRight.addEventListener('mousedown', e => startResize(e, propertiesEl, 'right'));
  }

  /* ---- Model Selection ---- */

  _selectDM(dmId) {
    const dm = this.project.model.dependencyModels[dmId];
    if (!dm) return;
    if (!this.project.representation.dmViews[dmId]) {
      this.project.representation.dmViews[dmId] = createDMView();
    }
    const view = this.project.representation.dmViews[dmId];
    if (this.dmEditor) {
      this.dmEditor.setDM(dm, view);
    }
    // Re-apply impact simulation if active
    if (this._impactSimActive) this._applyImpactSimulation();
    this.updateZoom(view.zoom || 1);
    this.setStatus(`Dependency Model: ${dm.name}`);
  }

  _applyImpactSimulation() {
    if (!this.dmEditor || !this.dmEditor.dm) return;
    const overrides = {};
    const impactedIds = new Set();
    for (const proc of Object.values(this.project.model.processes)) {
      for (const impact of (proc.activityImpacts || [])) {
        if (impact.paragonId) {
          overrides[impact.paragonId] = impact.newValue;
          impactedIds.add(impact.paragonId);
        }
      }
    }
    this.dmEditor.setImpactSimulation(overrides, impactedIds);
  }

  _selectRootProcess(procId) {
    if (this.pbEditor) {
      this.pbEditor.setProcess(procId);
    }
    const proc = this.project.model.processes[procId];
    if (proc) this._renderProcessProperties(proc);
    this.setStatus(`Playbook: ${proc ? proc.name : procId}`);
  }

  _selectProcessInView(procId) {
    // Navigate to the process in the pb editor
    const parent = Registry.parentProcess(this.project, procId);
    if (parent) {
      this._selectRootProcess(parent.id);
      if (this.pbEditor) this.pbEditor.selectProcess(procId);
    } else {
      this._selectRootProcess(procId);
    }
  }

  /* ---- DM Editor Callbacks ---- */

  onDMNodeSelected(paragon, dm) {
    if (!paragon) { this._showNoSelection(); return; }

    // Cross-DM proxy: show read-only info; navigation only on double-click or context menu
    if (paragon.proxyDMId && paragon.proxyParagonId) {
      this._renderProxyParagonProperties(paragon, dm);
      return;
    }

    this._renderParagonProperties(paragon, dm);
  }

  /** Navigate to the source DM of a proxy paragon and select the original node. */
  _navigateToProxySource(proxyParagon) {
    const extDM  = this.project.model.dependencyModels[proxyParagon.proxyDMId];
    const extPar = extDM && extDM.paragons[proxyParagon.proxyParagonId];
    if (extDM && extPar) {
      this._selectDM(proxyParagon.proxyDMId);
      this.dmEditor.selectNode(proxyParagon.proxyParagonId);
      this.setStatus(`\u2197 Navigated to "${extDM.name}" \u2014 editing original node.`);
    } else {
      this.setStatus('Cross-DM reference target not found.');
    }
  }

  _renderProxyParagonProperties(proxyParagon, dm) {
    const extDM  = this.project.model.dependencyModels[proxyParagon.proxyDMId];
    const extPar = extDM && extDM.paragons[proxyParagon.proxyParagonId];
    const el = this.els['properties-content'];
    el.innerHTML = '';

    const rows = [
      this._propRow('From DM', this._staticText(extDM ? extDM.name : '\u26a0 DM not found')),
    ];
    if (extPar) {
      const prob = Metrics.computeProbability(extPar.id, extDM.paragons, {}, this.project);
      rows.push(this._propRow('Node',        this._staticText(extPar.description)));
      rows.push(this._propRow('Type',        this._staticText(extPar.type)));
      rows.push(this._propRow('Probability', this._staticText(Metrics.formatProb(prob))));
    } else {
      rows.push(this._propRow('Node', this._staticText('\u26a0 Original node not found')));
    }
    el.appendChild(this._propGroup('Cross-DM Reference', rows));

    if (extDM && extPar) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn';
      btn.textContent = '\u2197 Open in ' + (extDM.name.length > 20 ? extDM.name.slice(0, 18) + '\u2026' : extDM.name);
      btn.style.cssText = 'margin:8px 0 0 0;width:100%';
      btn.addEventListener('click', () => this._navigateToProxySource(proxyParagon));
      el.appendChild(btn);
    }
  }

  _renderParagonProperties(paragon, dm) {
    const el = this.els['properties-content'];
    el.innerHTML = '';

    el.appendChild(this._propGroup('Paragon', [
      this._propRow('Description', this._textInput('desc', paragon.description, v => {
        this._pushUndo(); paragon.description = v;
        this.dmEditor.render(); this._renderExplorer(); this._markDirty(); this._syncImpactView();
      })),
      this._propRow('Type', this._selectInput('type', PARAGON_TYPE, paragon.type, v => {
        this._pushUndo(); paragon.type = v;
        this.dmEditor.render(); this._markDirty(); this._syncImpactView();
      })),
      this._propRow('Leaf Probability', (paragon.childIds.length === 0 || paragon.type === 'UNCONTROLLABLE') ?
        this._rangeInput('leafProb', paragon.leafProbability, 0, 1, 0.01, v => {
          this._pushUndo(); paragon.leafProbability = parseFloat(v);
          this.dmEditor.render(); this._markDirty(); this._syncImpactView();
        }) :
        this._staticText('Computed from children')
      )
    ]));

    // Computed values
    const prob = Metrics.computeProbability(paragon.id, dm.paragons, {}, this.project);
    // CiO = change caused by all activity impacts: P_after_all_impacts - P_before
    const allOverrides = this._buildImpactOverrides(null);
    const cio = Metrics.computeCiO(paragon.id, dm.paragons, allOverrides, this.project);
    const metricRows = [
      this._propRow('Probability', this._staticText(Metrics.formatProb(prob))),
      this._propRow('CiO', this._staticText(Metrics.formatCiO(cio),
        cio > 0 ? 'text-success' : (cio < 0 ? 'text-danger' : 'text-muted')
      ))
    ];
    // Show simulated probability if DM impact simulation is active
    if (this._impactSimActive && this.dmEditor && Object.keys(this.dmEditor.impactOverrides).length > 0) {
      const simProb = Metrics.computeProbability(paragon.id, dm.paragons, this.dmEditor.impactOverrides, this.project);
      const delta = simProb - prob;
      metricRows.push(this._propRow('Simulated Prob',
        this._staticText(`${Metrics.formatProb(simProb)} (${Metrics.formatCiO(delta)})`,
          delta > 0.001 ? 'text-success' : (delta < -0.001 ? 'text-danger' : 'text-muted'))
      ));
    }
    // Show Impact View execution overrides (execute/step mode)
    const ivOverrides = this.impactView && Object.keys(this.impactView._simOverrides || {}).length > 0
      ? this.impactView._simOverrides : null;
    if (ivOverrides) {
      const simProb = Metrics.computeProbability(paragon.id, dm.paragons, ivOverrides, this.project);
      const delta = simProb - prob;
      metricRows.push(this._propRow('After Execution',
        this._staticText(`${Metrics.formatProb(simProb)} (${Metrics.formatCiO(delta)})`,
          delta > 0.001 ? 'text-success' : (delta < -0.001 ? 'text-danger' : 'text-muted'))
      ));
    }
    el.appendChild(this._propGroup('Computed Metrics', metricRows));

    // Critical Threshold & Notifications
    el.appendChild(this._renderParagonCT(paragon, dm));

    // Children list
    const childGroup = document.createElement('div');
    childGroup.className = 'prop-group';
    const cgTitle = document.createElement('div');
    cgTitle.className = 'prop-group-title';
    cgTitle.textContent = `Children (${paragon.childIds.length})`;
    childGroup.appendChild(cgTitle);
    const childList = document.createElement('ul');
    childList.className = 'prop-list';
    for (const cid of paragon.childIds) {
      const child = dm.paragons[cid];
      if (!child) continue;
      const li = document.createElement('li');
      li.innerHTML = `<span class="pli-label">${this._esc(child.description)}</span>`;
      const delBtn = document.createElement('button');
      delBtn.className = 'pli-btn del';
      delBtn.textContent = '×';
      delBtn.title = 'Remove child';
      delBtn.addEventListener('click', () => this._removeParagonChild(paragon, cid, dm));
      li.appendChild(delBtn);
      childList.appendChild(li);
    }
    childGroup.appendChild(childList);

    const addAND = document.createElement('button');
    addAND.className = 'prop-add tool-btn';
    addAND.textContent = '+ AND child';
    addAND.addEventListener('click', () => this._addParagonChildTo(paragon.id, PARAGON_TYPE.AND, dm));
    childGroup.appendChild(addAND);

    const addOR = document.createElement('button');
    addOR.className = 'prop-add tool-btn';
    addOR.style.marginTop = '4px';
    addOR.textContent = '+ OR child';
    addOR.addEventListener('click', () => this._addParagonChildTo(paragon.id, PARAGON_TYPE.OR, dm));
    childGroup.appendChild(addOR);

    const addLeaf = document.createElement('button');
    addLeaf.className = 'prop-add tool-btn';
    addLeaf.style.marginTop = '4px';
    addLeaf.textContent = '+ Leaf (Uncontrollable)';
    addLeaf.addEventListener('click', () => this._addParagonChildTo(paragon.id, PARAGON_TYPE.UNCONTROLLABLE, dm));
    childGroup.appendChild(addLeaf);

    el.appendChild(childGroup);

    // Linked activities
    const linked = Object.values(this.project.model.processes)
      .filter(p => p.paragonId === paragon.id || p.activityImpacts.some(ai => ai.paragonId === paragon.id));
    if (linked.length > 0) {
      el.appendChild(this._propGroup('Linked Activities', [
        ...linked.map(p => this._propRow('', this._staticText(p.name)))
      ]));
    }

    // MITRE ATT&CK / D3FEND mappings from linked processes
    const allAttack = [];
    const allDefend = [];
    const seenAttack = new Set();
    const seenDefend = new Set();
    for (const p of linked) {
      for (const t of (p.mitreTechniques || [])) {
        if (!seenAttack.has(t.techniqueId)) { seenAttack.add(t.techniqueId); allAttack.push(t); }
      }
      for (const d of (p.mitreDefend || [])) {
        if (!seenDefend.has(d.techniqueId)) { seenDefend.add(d.techniqueId); allDefend.push(d); }
      }
    }
    if (allAttack.length > 0 || allDefend.length > 0) {
      const mitreGroup = document.createElement('div');
      mitreGroup.className = 'prop-group';
      const mitreTitle = document.createElement('div');
      mitreTitle.className = 'prop-group-title';
      mitreTitle.textContent = 'MITRE ATT&CK / D3FEND';
      mitreGroup.appendChild(mitreTitle);

      if (allAttack.length > 0) {
        const attackLabel = document.createElement('div');
        attackLabel.style.cssText = 'font-size:11px;color:var(--text-secondary);margin:4px 0 2px 0;font-weight:600';
        attackLabel.textContent = 'ATT&CK Techniques';
        mitreGroup.appendChild(attackLabel);
        for (const t of allAttack) {
          const row = document.createElement('div');
          row.style.cssText = 'font-size:11px;padding:2px 0;display:flex;gap:6px;align-items:baseline';
          const id = document.createElement('a');
          id.href = t.url || '#';
          id.target = '_blank';
          id.rel = 'noopener';
          id.textContent = t.techniqueId;
          id.style.cssText = 'color:var(--accent);text-decoration:none;font-weight:600;white-space:nowrap';
          const name = document.createElement('span');
          name.textContent = t.techniqueName + (t.tactic ? ` (${t.tactic})` : '');
          name.style.cssText = 'color:var(--text-primary);overflow:hidden;text-overflow:ellipsis';
          row.appendChild(id);
          row.appendChild(name);
          mitreGroup.appendChild(row);
        }
      }

      if (allDefend.length > 0) {
        const defendLabel = document.createElement('div');
        defendLabel.style.cssText = 'font-size:11px;color:var(--text-secondary);margin:8px 0 2px 0;font-weight:600';
        defendLabel.textContent = 'D3FEND Countermeasures';
        mitreGroup.appendChild(defendLabel);
        for (const d of allDefend) {
          const row = document.createElement('div');
          row.style.cssText = 'font-size:11px;padding:2px 0;display:flex;gap:6px;align-items:baseline';
          const id = document.createElement('a');
          id.href = d.url || '#';
          id.target = '_blank';
          id.rel = 'noopener';
          id.textContent = d.techniqueId;
          id.style.cssText = 'color:#22c55e;text-decoration:none;font-weight:600;white-space:nowrap';
          const name = document.createElement('span');
          name.textContent = d.techniqueName + (d.tactic ? ` (${d.tactic})` : '');
          name.style.cssText = 'color:var(--text-primary);overflow:hidden;text-overflow:ellipsis';
          row.appendChild(id);
          row.appendChild(name);
          mitreGroup.appendChild(row);
        }
      }

      el.appendChild(mitreGroup);
    }
  }

  _renderParagonCT(paragon, dm) {
    const group = document.createElement('div');
    group.className = 'prop-group';
    const title = document.createElement('div');
    title.className = 'prop-group-title';
    title.textContent = 'Critical Threshold & Notifications';
    group.appendChild(title);

    const ct = paragon.criticalThreshold;
    const hasCT = ct !== null && ct !== undefined;

    // Enable/disable CT
    const enableRow = document.createElement('div');
    enableRow.className = 'prop-row';
    const enableLabel = document.createElement('label');
    enableLabel.className = 'checkbox-item';
    enableLabel.style.cssText = 'font-size:12px;cursor:pointer;';
    const enableCb = document.createElement('input');
    enableCb.type = 'checkbox';
    enableCb.checked = hasCT;
    enableLabel.appendChild(enableCb);
    enableLabel.appendChild(document.createTextNode(' Enable Critical Threshold'));
    enableRow.appendChild(enableLabel);
    group.appendChild(enableRow);

    // CT value row (conditionally visible)
    const ctValueRow = this._propRow('Min. Probability',
      this._rangeInput('ct', hasCT ? ct : 0.5, 0, 1, 0.01, v => {
        paragon.criticalThreshold = parseFloat(v);
        this._markDirty();
        this._renderParagonProperties(paragon, dm);
      })
    );
    ctValueRow.style.display = hasCT ? '' : 'none';
    group.appendChild(ctValueRow);

    // Notify mode
    const notifyRow = this._propRow('On Breach',
      this._selectInput('notifyMode',
        { NOTIFY_ONLY: 'NOTIFY_ONLY', REQUEST_APPROVAL: 'REQUEST_APPROVAL' },
        paragon.notifyMode || 'NOTIFY_ONLY',
        v => { paragon.notifyMode = v; this._markDirty(); }
      )
    );
    notifyRow.style.display = hasCT ? '' : 'none';
    group.appendChild(notifyRow);

    // CT status banner
    if (hasCT) {
      const prob = Metrics.computeProbability(paragon.id, dm.paragons, {}, this.project);
      const allOv = {};
      for (const proc of Object.values(this.project.model.processes)) {
        for (const imp of (proc.activityImpacts || []))
          if (imp.paragonId) allOv[imp.paragonId] = imp.newValue;
      }
      const simProb = Metrics.computeProbability(paragon.id, dm.paragons, allOv, this.project);
      const isCurrent = prob < ct;
      const isPlanned = !isCurrent && simProb < ct;
      if (isCurrent || isPlanned) {
        const banner = document.createElement('div');
        banner.style.cssText = `background:${isCurrent ? '#3a0a0a' : '#2a1a00'};border:1px solid ${isCurrent ? '#e74c3c' : '#f39c12'};border-radius:4px;padding:6px 8px;font-size:10px;margin-top:6px;`;
        const mode = paragon.notifyMode === 'REQUEST_APPROVAL' ? 'Request Approval Required' : 'Stakeholder Notification Required';
        banner.innerHTML = isCurrent
          ? `<span style="color:#e74c3c;font-weight:bold">⚠ BELOW THRESHOLD</span><br>Current: ${Metrics.formatProb(prob)} &lt; CT: ${ct} — <b>${mode}</b>`
          : `<span style="color:#f39c12;font-weight:bold">⚠ PLANNED BREACH</span><br>After planned actions: ${Metrics.formatProb(simProb)} &lt; CT: ${ct} — <b>${mode}</b>`;
        group.appendChild(banner);
      }
    }

    // Stakeholders list
    const stkTitle = document.createElement('div');
    stkTitle.style.cssText = 'font-size:10px;color:var(--text-secondary);margin-top:8px;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.4px;';
    stkTitle.textContent = 'Stakeholders';
    group.appendChild(stkTitle);

    const stakeholders = paragon.stakeholders || (paragon.stakeholders = []);
    const allRoles = Object.values(this.project.model.roles || {});
    const list = document.createElement('ul');
    list.className = 'prop-list';
    for (const stk of stakeholders) {
      const linkedRole = stk.roleId ? this.project.model.roles[stk.roleId] : null;
      const displayName = linkedRole ? linkedRole.name : stk.name;
      const roleBadge   = linkedRole ? ` <span style="font-size:9px;color:#a855f7;background:#1a0a2e;padding:1px 4px;border-radius:3px;margin-left:4px;">Role</span>` : '';
      const li = document.createElement('li');
      li.innerHTML = `<span class="pli-label">${this._esc(displayName)}${roleBadge}${stk.contact ? ' &lt;' + this._esc(stk.contact) + '&gt;' : ''}</span>`;
      const del = document.createElement('button');
      del.className = 'pli-btn del'; del.textContent = '×';
      del.addEventListener('click', () => {
        paragon.stakeholders = paragon.stakeholders.filter(s => s !== stk);
        this._markDirty();
        this._renderParagonProperties(paragon, dm);
      });
      li.appendChild(del);
      list.appendChild(li);
    }
    group.appendChild(list);

    const addStkBtn = document.createElement('button');
    addStkBtn.className = 'prop-add tool-btn';
    addStkBtn.textContent = '+ Add Stakeholder';
    addStkBtn.addEventListener('click', () => {
      const roleOptions = allRoles.map(r =>
        `<option value="${this._esc(r.id)}">${this._esc(r.name)}</option>`).join('');
      this.showModal('Add Stakeholder',
        `<div class="prop-row"><label class="prop-label">Link to Role (optional)</label>
           <select id="stk-role" style="width:100%">
             <option value="">— free-text name —</option>
             ${roleOptions}
           </select></div>
         <div class="prop-row"><label class="prop-label">Name</label>
           <input id="stk-name" type="text" placeholder="e.g. CISO" style="width:100%"></div>
         <div class="prop-row"><label class="prop-label">Contact (email / phone)</label>
           <input id="stk-contact" type="text" placeholder="optional" style="width:100%"></div>`,
        () => {
          const roleId  = document.getElementById('stk-role').value || null;
          const role    = roleId ? this.project.model.roles[roleId] : null;
          const name    = role
            ? role.name
            : document.getElementById('stk-name').value.trim();
          if (!name) return;
          (paragon.stakeholders = paragon.stakeholders || [])
            .push({ name, contact: document.getElementById('stk-contact').value.trim() || '', roleId: roleId || null });
          this._markDirty();
          this._renderParagonProperties(paragon, dm);
        }
      );
      // Auto-fill name when a role is chosen
      setTimeout(() => {
        const roleSel = document.getElementById('stk-role');
        const nameIn  = document.getElementById('stk-name');
        if (roleSel && nameIn) {
          roleSel.addEventListener('change', () => {
            const r = roleSel.value ? this.project.model.roles[roleSel.value] : null;
            if (r) { nameIn.value = r.name; nameIn.disabled = true; }
            else   { nameIn.value = '';      nameIn.disabled = false; }
          });
        }
      }, 0);
    });
    group.appendChild(addStkBtn);

    // Wire enable checkbox AFTER building rows (so refs exist)
    enableCb.addEventListener('change', () => {
      paragon.criticalThreshold = enableCb.checked ? 0.5 : null;
      this._markDirty();
      this._renderParagonProperties(paragon, dm);
    });

    return group;
  }

  /* ---- PB Editor Callbacks ---- */

  onPBNodeSelected(proc) {
    if (!proc) { this._showNoSelection(); return; }
    this._renderProcessProperties(proc);
  }

  onPBConnectionSelected(inst) {
    if (!inst) { this._showNoSelection(); return; }
    this._renderConnectionProperties(inst);
  }

  _renderProcessProperties(proc) {
    const el = this.els['properties-content'];
    el.innerHTML = '';

    el.appendChild(this._propGroup('Activity', [
      this._propRow('Name', this._textInput('name', proc.name, v => {
        this._pushUndo(); proc.name = v;
        this.pbEditor && this.pbEditor.render();
        this._renderExplorer(); this._markDirty(); this._syncImpactView();
      })),
      this._propRow('Notes', this._textareaInput('notes', proc.notes, v => {
        proc.notes = v; this._markDirty();
      })),
      this._propRow('Action Type', this._selectInput('actionType', ACTION_TYPE_ENUM, proc.actionType, v => {
        proc.actionType = v;
        this.pbEditor && this.pbEditor.render(); this._markDirty();
      })),
      this._propRow('Status', this._selectInput('status', STATUS_ENUM, proc.status, v => {
        proc.status = v;
        this.pbEditor && this.pbEditor.render(); this._markDirty(); this._syncImpactView();
      })),
    ]));

    // Sub-Activities
    el.appendChild(this._renderSubActivities(proc));

    // Objectives (multi-select)
    const objGroup = document.createElement('div');
    objGroup.className = 'prop-group';
    const objTitle = document.createElement('div');
    objTitle.className = 'prop-group-title';
    objTitle.textContent = 'Objectives';
    objGroup.appendChild(objTitle);
    const objRow = document.createElement('div');
    objRow.className = 'checkbox-row';
    for (const [key, val] of Object.entries(OBJECTIVES_ENUM)) {
      const label = document.createElement('label');
      label.className = 'checkbox-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = proc.objectives.includes(val);
      cb.addEventListener('change', () => {
        if (cb.checked) { if (!proc.objectives.includes(val)) proc.objectives.push(val); }
        else proc.objectives = proc.objectives.filter(o => o !== val);
        this.pbEditor && this.pbEditor.render(); this._markDirty();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(key));
      objRow.appendChild(label);
    }
    objGroup.appendChild(objRow);
    el.appendChild(objGroup);

    // Dates
    el.appendChild(this._propGroup('Scheduling', [
      this._propRow('Start Date', this._dateInput('startDate', proc.startDate, v => {
        proc.startDate = v || null; this._markDirty();
      })),
      this._propRow('End Date', this._dateInput('endDate', proc.endDate, v => {
        proc.endDate = v || null; this._markDirty();
      }))
    ]));

    // Link to Paragon
    el.appendChild(this._propGroup('Dependency Model Link', [
      this._propRow('Linked Paragon', this._paragonSelect(proc.paragonId, v => {
        proc.paragonId = v || null; this._markDirty();
      }))
    ]));

    // Associated Roles
    this._renderRolesList(el, proc);

    // Actuators (Resources)
    this._renderActuatorsList(el, proc);

    // Activity Impacts
    this._renderActivityImpacts(el, proc);

    // External References
    this._renderExternalRefs(el, proc);

    // Sub-processes (drill-down button)
    if (proc.subProcessIds.length > 0) {
      const btn = document.createElement('button');
      btn.className = 'tool-btn';
      btn.style.width = '100%';
      btn.style.marginTop = '8px';
      btn.textContent = `▶ Drill down (${proc.subProcessIds.length} sub-activities)`;
      btn.addEventListener('click', () => this.pbEditor && this.pbEditor.drillDown(proc.id));
      el.appendChild(btn);
    }

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.style.width = '100%';
    delBtn.style.marginTop = '12px';
    delBtn.textContent = '× Delete Activity';
    delBtn.addEventListener('click', () => this._deleteProcess(proc.id));
    el.appendChild(delBtn);
  }

  _renderConnectionProperties(inst) {
    const el = this.els['properties-content'];
    el.innerHTML = '';

    // Find associated artifact/state
    let linkedArtifact = null, linkedState = null;
    for (const art of Object.values(this.project.model.artifacts)) {
      for (const stId of art.stateIds) {
        const st = this.project.model.artifactStates[stId];
        if (st && st.instanceIds.includes(inst.id)) {
          linkedArtifact = art; linkedState = st; break;
        }
      }
      if (linkedArtifact) break;
    }

    const fromProc = Registry.getProcess(this.project, inst.originatingActivity);
    const toProc   = Registry.getProcess(this.project, inst.usedByActivity);

    el.appendChild(this._propGroup('Artifact Flow', [
      this._propRow('From', this._staticText(fromProc ? fromProc.name : '(root)')),
      this._propRow('To', this._staticText(toProc ? toProc.name : '(root)')),
    ]));

    if (linkedArtifact) {
      el.appendChild(this._propGroup('Artifact', [
        this._propRow('Name', this._textInput('artName', linkedArtifact.name, v => {
          linkedArtifact.name = v; this._markDirty();
        })),
        this._propRow('State', this._textInput('stateName', linkedState ? linkedState.name : '', v => {
          if (linkedState) { linkedState.name = v; linkedState.artifactName = linkedArtifact.name; }
          this._markDirty();
        })),
        this._propRow('Achieved', this._checkInput('achieved', linkedState ? linkedState.achievedStatus : false, v => {
          if (linkedState) { linkedState.achievedStatus = v; this._markDirty(); this.pbEditor && this.pbEditor.render(); }
        }))
      ]));
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'danger-btn';
    delBtn.style.width = '100%';
    delBtn.style.marginTop = '12px';
    delBtn.textContent = '× Delete Connection';
    delBtn.addEventListener('click', () => {
      this._deleteConnection(inst.id);
    });
    el.appendChild(delBtn);
  }

  _renderRolesList(el, proc) {
    const orgForProc = Object.values(this.project.model.organisations).find(
      org => org.rootProcessIds.includes(this._getRootProcessId(proc.id))
    );

    const group = document.createElement('div');
    group.className = 'prop-group';
    const title = document.createElement('div');
    title.className = 'prop-group-title';
    title.textContent = 'Associated Roles';
    group.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'prop-list';
    for (const rid of proc.associatedRoleIds) {
      const role = this.project.model.roles[rid];
      const li = document.createElement('li');
      li.innerHTML = `<span class="pli-label">${this._esc(role ? role.name : rid)}</span>`;
      const del = document.createElement('button');
      del.className = 'pli-btn del'; del.textContent = '×';
      del.addEventListener('click', () => {
        proc.associatedRoleIds = proc.associatedRoleIds.filter(r => r !== rid);
        this._renderProcessProperties(proc); this._markDirty();
      });
      li.appendChild(del);
      list.appendChild(li);
    }
    group.appendChild(list);

    if (orgForProc && orgForProc.roleIds.length > 0) {
      const sel = document.createElement('select');
      sel.style.marginTop = '4px'; sel.style.width = '100%';
      const opt0 = document.createElement('option');
      opt0.value = ''; opt0.textContent = '— Add role —';
      sel.appendChild(opt0);
      for (const rid of orgForProc.roleIds) {
        if (proc.associatedRoleIds.includes(rid)) continue;
        const role = this.project.model.roles[rid];
        const opt = document.createElement('option');
        opt.value = rid; opt.textContent = role ? role.name : rid;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        if (sel.value) {
          proc.associatedRoleIds.push(sel.value);
          this._renderProcessProperties(proc); this._markDirty();
        }
      });
      group.appendChild(sel);
    }

    // Always show a create-role shortcut so the user can add new roles in context
    const newRoleBtn = document.createElement('button');
    newRoleBtn.className = 'prop-add tool-btn';
    newRoleBtn.textContent = '+ New Role';
    newRoleBtn.style.marginTop = '4px';
    newRoleBtn.addEventListener('click', () => {
      const oid = orgForProc ? orgForProc.id : null;
      this._addRole(oid);
      // Re-render props after the modal closes so the new role appears in the dropdown
      setTimeout(() => this._renderProcessProperties(proc), 50);
    });
    group.appendChild(newRoleBtn);

    el.appendChild(group);
  }

  _renderActuatorsList(el, proc) {
    const group = document.createElement('div');
    group.className = 'prop-group';
    const title = document.createElement('div');
    title.className = 'prop-group-title'; title.textContent = 'Actuators (Resources)';
    group.appendChild(title);

    const list = document.createElement('ul'); list.className = 'prop-list';
    for (const rid of proc.resourceIds) {
      const act = this.project.model.actuators[rid];
      const li = document.createElement('li');
      li.innerHTML = `<span class="pli-label">${this._esc(act ? `${act.name} [${act.actuatorType}]` : rid)}</span>`;
      const del = document.createElement('button');
      del.className = 'pli-btn del'; del.textContent = '×';
      del.addEventListener('click', () => {
        proc.resourceIds = proc.resourceIds.filter(r => r !== rid);
        delete this.project.model.actuators[rid];
        this._renderProcessProperties(proc); this._markDirty();
      });
      li.appendChild(del);
      list.appendChild(li);
    }
    group.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.className = 'prop-add tool-btn'; addBtn.textContent = '+ Add Actuator';
    addBtn.addEventListener('click', () => this._addActuatorToProcess(proc));
    group.appendChild(addBtn);
    el.appendChild(group);
  }

  _renderActivityImpacts(el, proc) {
    const group = document.createElement('div');
    group.className = 'prop-group';
    const title = document.createElement('div');
    title.className = 'prop-group-title'; title.textContent = 'Activity Impacts (CiO)';
    group.appendChild(title);

    for (const impact of proc.activityImpacts) {
      const dm = Registry.findDMForParagon(this.project, impact.paragonId);
      const paragon = dm && dm.paragons[impact.paragonId];
      const row = document.createElement('div');
      row.style.cssText = 'background:#1a2035;border-radius:4px;padding:6px 8px;margin-bottom:6px;';

      const pLabel = document.createElement('div');
      pLabel.style.cssText = 'font-size:11px;color:#8899b0;margin-bottom:4px;';
      pLabel.textContent = paragon ? paragon.description : (impact.paragonId || 'Unlinked');
      row.appendChild(pLabel);

      const valRow = document.createElement('div');
      valRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

      const valLabel = document.createElement('span');
      valLabel.style.cssText = 'font-size:11px;color:#8899b0;';
      valLabel.textContent = 'New value:';
      valRow.appendChild(valLabel);

      const valInput = document.createElement('input');
      valInput.type = 'number'; valInput.min = '0'; valInput.max = '1'; valInput.step = '0.01';
      valInput.value = impact.newValue;
      valInput.style.cssText = 'width:70px;';
      valInput.addEventListener('change', () => {
        impact.newValue = parseFloat(valInput.value); this._markDirty(); this._syncImpactView();
      });
      valRow.appendChild(valInput);

      const del = document.createElement('button');
      del.className = 'pli-btn del'; del.textContent = '×'; del.style.marginLeft = 'auto';
      del.addEventListener('click', () => {
        proc.activityImpacts = proc.activityImpacts.filter(i => i !== impact);
        this._renderProcessProperties(proc); this._markDirty(); this._syncImpactView();
      });
      valRow.appendChild(del);
      row.appendChild(valRow);

      if (paragon && dm) {
        const originalProb = Metrics.computeProbability(paragon.id, dm.paragons, {}, this.project);
        const delta = impact.newValue - originalProb;
        const deltaEl = document.createElement('div');
        deltaEl.style.cssText = 'font-size:10px;margin-top:3px;';
        deltaEl.className = delta > 0 ? 'text-success' : (delta < 0 ? 'text-danger' : 'text-muted');
        deltaEl.textContent = `${Metrics.formatProb(originalProb)} → ${Metrics.formatProb(impact.newValue)}  CiO: ${Metrics.formatCiO(delta)}`;
        row.appendChild(deltaEl);
      }

      group.appendChild(row);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'prop-add tool-btn'; addBtn.textContent = '+ Add Impact';
    addBtn.addEventListener('click', () => this._addActivityImpact(proc));
    group.appendChild(addBtn);
    el.appendChild(group);
  }

  _renderSubActivities(proc) {
    const group = document.createElement('div');
    group.className = 'prop-group';
    const title = document.createElement('div');
    title.className = 'prop-group-title';
    title.textContent = 'Sub-Activities';
    group.appendChild(title);

    const subIds = proc.subProcessIds || [];

    if (subIds.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'no-selection';
      empty.style.cssText = 'font-size:10px;margin:4px 0 6px;';
      empty.textContent = 'No sub-activities.';
      group.appendChild(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'prop-list';
      for (const subId of subIds) {
        const sub = this.project.model.processes[subId];
        if (!sub) continue;
        const li = document.createElement('li');
        li.style.cssText = 'align-items:center;';

        const lbl = document.createElement('span');
        lbl.className = 'pli-label';
        lbl.style.cursor = 'pointer';
        lbl.title = 'Click to select this sub-activity';
        lbl.textContent = sub.name || '(unnamed)';
        lbl.addEventListener('click', () => this._renderProcessProperties(sub));
        li.appendChild(lbl);

        const delBtn = document.createElement('button');
        delBtn.className = 'pli-btn del'; delBtn.textContent = '×';
        delBtn.title = 'Remove sub-activity (deletes it and all its descendants)';
        delBtn.addEventListener('click', () => {
          if (!confirm(`Delete "${sub.name}" and all its sub-activities?`)) return;
          this._deleteProcess(subId);
          this._renderProcessProperties(proc);
        });
        li.appendChild(delBtn);
        list.appendChild(li);
      }
      group.appendChild(list);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'prop-add tool-btn';
    addBtn.textContent = '+ Add Sub-Activity';
    addBtn.addEventListener('click', () => {
      this.showModal('Add Sub-Activity',
        `<div class="prop-row"><label class="prop-label">Name</label>
           <input id="sub-name" type="text" placeholder="Activity name" style="width:100%"></div>
         <div class="prop-row"><label class="prop-label">Action Type</label>
           <select id="sub-type" style="width:100%">
             ${Object.entries(ACTION_TYPE_ENUM).map(([k, v]) =>
               `<option value="${v}">${k}</option>`).join('')}
           </select></div>`,
        () => {
          const name = document.getElementById('sub-name').value.trim();
          if (!name) return;
          this._pushUndo();
          const sub = createProcess(name);
          sub.actionType = document.getElementById('sub-type').value;
          this.project.model.processes[sub.id] = sub;
          proc.subProcessIds.push(sub.id);
          this.pbEditor && this.pbEditor.render();
          this._renderExplorer();
          this._markDirty();
          this._syncImpactView();
          // Refresh step queue if in step mode
          if (this.impactView && this.impactView._simMode === 'step' &&
              this.impactView.selectedRootProcessId) {
            this.impactView._stepQueue =
              this.impactView._buildStepQueue(this.impactView.selectedRootProcessId);
          }
          this._renderProcessProperties(proc);
          this.setStatus(`Added sub-activity: ${name}`);
        }
      );
    });
    group.appendChild(addBtn);
    return group;
  }

  _renderExternalRefs(el, proc) {
    const group = document.createElement('div');
    group.className = 'prop-group';
    const title = document.createElement('div');
    title.className = 'prop-group-title'; title.textContent = 'External References';
    group.appendChild(title);

    const list = document.createElement('ul'); list.className = 'prop-list';
    for (const ref of proc.externalReferences) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="pli-label">${this._esc(ref.name || ref.referenceType)}</span>
        <span style="font-size:9px;color:#546e7a">${ref.referenceType}</span>`;
      const del = document.createElement('button');
      del.className = 'pli-btn del'; del.textContent = '×';
      del.addEventListener('click', () => {
        proc.externalReferences = proc.externalReferences.filter(r => r !== ref);
        this._renderProcessProperties(proc); this._markDirty();
      });
      li.appendChild(del);
      list.appendChild(li);
    }
    group.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.className = 'prop-add tool-btn'; addBtn.textContent = '+ Add Reference';
    addBtn.addEventListener('click', () => this._addExternalRef(proc));
    group.appendChild(addBtn);
    el.appendChild(group);
  }

  /* ---- Model Operations ---- */

  _addDependencyModel() {
    this.showInputModal('New Dependency Model', 'Enter model name:', 'System Dependency Model', name => {
      if (!name.trim()) return;
      this._pushUndo();
      const dm = createDependencyModel(name.trim());
      this.project.model.dependencyModels[dm.id] = dm;
      this.project.representation.dmViews[dm.id] = createDMView();
      this._renderExplorer();
      this._selectDM(dm.id);
      this._switchTab('dm');
      this._markDirty();
      this.setStatus(`Created dependency model: ${dm.name}`);
    });
  }

  _addParagonChild(type) {
    if (!this.dmEditor || !this.dmEditor.dm) {
      this.setStatus('Select a dependency model first.'); return;
    }
    const selectedId = this.dmEditor.getSelectedId();
    if (selectedId) {
      this._addParagonChildTo(selectedId, type, this.dmEditor.dm);
    } else {
      this._addStandaloneParagon(type, this.dmEditor.dm);
    }
  }

  /** Called when user drags from node A's port and releases on node B.
   *  Makes B a child of A (if it wouldn't create a cycle). */
  dmConnectNodes(fromId, toId, dm) {
    if (ModelValidator.wouldCreateCycle(fromId, toId, dm.paragons)) {
      this.setStatus('Cannot connect: would create a cycle in the dependency model.');
      return;
    }
    // Prevent duplicate edges
    if (dm.paragons[fromId].childIds.includes(toId)) {
      this.setStatus('Already connected.');
      return;
    }
    this._pushUndo();
    const fromNode = dm.paragons[fromId];
    if (fromNode.type === PARAGON_TYPE.UNCONTROLLABLE) fromNode.type = PARAGON_TYPE.AND;
    fromNode.childIds.push(toId);
    this.dmEditor.render();
    this._renderExplorer();
    this._markDirty();
    this.setStatus(`Connected: ${fromNode.description} → ${dm.paragons[toId].description}`);
  }

  /** Add a cross-DM child (proxy paragon) to nodeId in dm. */
  _addCrossDMChild(parentId, dm) {
    // Collect all non-proxy paragons from other DMs
    const options = [];
    for (const [dmId, extDM] of Object.entries(this.project.model.dependencyModels)) {
      if (dmId === dm.id) continue;
      for (const par of Object.values(extDM.paragons)) {
        if (par.proxyDMId) continue;  // no proxy-of-proxy
        // Skip if a proxy for this target already exists as a child of parentId
        const alreadyChild = dm.paragons[parentId].childIds.some(cid => {
          const cp = dm.paragons[cid];
          return cp && cp.proxyDMId === dmId && cp.proxyParagonId === par.id;
        });
        if (alreadyChild) continue;
        options.push({ dmId, dmName: extDM.name, parId: par.id, parDesc: par.description, parType: par.type });
      }
    }
    if (options.length === 0) {
      this.setStatus('No paragons available from other dependency models (or all are already linked).');
      return;
    }
    // Group by DM for readable optgroups
    const grouped = {};
    for (const o of options) {
      if (!grouped[o.dmId]) grouped[o.dmId] = { name: o.dmName, items: [] };
      grouped[o.dmId].items.push(o);
    }
    const optsHtml = Object.values(grouped).map(g =>
      `<optgroup label="${this._esc(g.name)}">${
        g.items.map(o =>
          `<option value="${this._esc(o.dmId)}::${this._esc(o.parId)}">` +
          `${this._esc(o.parDesc)} (${o.parType})</option>`
        ).join('')
      }</optgroup>`
    ).join('');

    this.showModal('\u{1F310} Add Cross-DM Child',
      `<p style="font-size:11px;color:#8899b0;margin-bottom:8px">
         Select a paragon from another dependency model to reference as a child.
         It will appear in this diagram but can only be edited in its original DM.
       </p>
       <div class="prop-row">
         <label class="prop-label">Target Paragon</label>
         <select id="xdm-select" style="width:100%">${optsHtml}</select>
       </div>`,
      () => {
        const val = document.getElementById('xdm-select').value;
        if (!val) return;
        const sep = val.indexOf('::');
        const targetDMId  = val.slice(0, sep);
        const targetParId = val.slice(sep + 2);
        if (this._wouldCreateCrossDMCycle(dm.id, parentId, targetDMId, targetParId)) {
          this.setStatus('Cannot add: this would create a cycle across dependency models.');
          return;
        }
        this._pushUndo();
        const proxy = createProxyParagon(targetDMId, targetParId);
        dm.paragons[proxy.id] = proxy;
        const view = this.project.representation.dmViews[dm.id];
        if (view) {
          const parentPos = view.nodePositions[parentId] || { x: 0, y: 0 };
          const sibCount = dm.paragons[parentId].childIds.length;
          view.nodePositions[proxy.id] = { x: parentPos.x + sibCount * 190, y: parentPos.y + 90 };
        }
        const parentPar = dm.paragons[parentId];
        if (parentPar.type === PARAGON_TYPE.UNCONTROLLABLE) parentPar.type = PARAGON_TYPE.AND;
        parentPar.childIds.push(proxy.id);
        this.dmEditor.render();
        this._renderExplorer();
        this._markDirty();
        this.setStatus('Cross-DM reference added.');
      }
    );
  }

  /**
   * Returns true if adding proxy(targetDMId/targetParId) as child of
   * (parentDMId/parentParId) would create a cross-DM cycle.
   * A cycle exists if parentParId is reachable as a descendant of targetParId
   * following both local childIds and cross-DM proxy links.
   */
  _wouldCreateCrossDMCycle(parentDMId, parentParId, targetDMId, targetParId) {
    const visited = new Set();
    const stack   = [[targetDMId, targetParId]];
    while (stack.length > 0) {
      const [dmId, parId] = stack.pop();
      const key = `${dmId}||${parId}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (dmId === parentDMId && parId === parentParId) return true;
      const dm  = this.project.model.dependencyModels[dmId];
      if (!dm) continue;
      const par = dm.paragons[parId];
      if (!par) continue;
      for (const cid of par.childIds) {
        const cp = dm.paragons[cid];
        if (!cp) continue;
        if (cp.proxyDMId && cp.proxyParagonId) {
          stack.push([cp.proxyDMId, cp.proxyParagonId]);
        } else {
          stack.push([dmId, cid]);
        }
      }
    }
    return false;
  }

  /**
   * Handle a paragon dragged from the Model Explorer and dropped onto the DM canvas.
   * If cross-DM: creates a proxy child under the drop target node (no modal).
   * If same DM: connects the dragged paragon as a child of the drop target.
   */
  dropParagonOnDM(dropEvent, srcDmId, srcParId, targetDm, editor) {
    if (!targetDm) return;
    const srcDM  = this.project.model.dependencyModels[srcDmId];
    const srcPar = srcDM && srcDM.paragons[srcParId];
    if (!srcPar) { this.setStatus('Source paragon not found.'); return; }
    if (srcPar.proxyDMId) { this.setStatus('Cannot add a proxy-of-proxy reference.'); return; }

    const parentId = editor._getNodeIdAt(dropEvent);
    const svgPt    = editor._toSVGCoords(dropEvent);

    if (!parentId) {
      // Dropped on empty canvas — add as standalone proxy (cross-DM only)
      if (srcDmId === targetDm.id) {
        this.setStatus('Drag onto a paragon node to connect within the same DM.');
        return;
      }
      // Check if a proxy for this target already exists anywhere in this DM
      const alreadyExists = Object.values(targetDm.paragons).some(p =>
        p.proxyDMId === srcDmId && p.proxyParagonId === srcParId);
      if (alreadyExists) { this.setStatus('A reference to this paragon already exists in this DM.'); return; }

      this._pushUndo();
      const proxy = createProxyParagon(srcDmId, srcParId);
      targetDm.paragons[proxy.id] = proxy;
      const view = this.project.representation.dmViews[targetDm.id];
      if (view) view.nodePositions[proxy.id] = { x: Math.round(svgPt.x - 80), y: Math.round(svgPt.y - 30) };
      this.dmEditor.render();
      this._renderExplorer();
      this._markDirty();
      this.setStatus(`Cross-DM reference added: "${srcPar.description}" (standalone — connect via right-click)`);
      return;
    }

    if (srcDmId === targetDm.id) {
      if (parentId !== srcParId) this.dmConnectNodes(srcParId, parentId, targetDm);
      else this.setStatus('Cannot connect a node to itself.');
      return;
    }

    // Cross-DM: dropped onto an existing node — add as child of that node
    const parentPar = targetDm.paragons[parentId];
    if (!parentPar) return;
    const alreadyChild = parentPar.childIds.some(cid => {
      const cp = targetDm.paragons[cid];
      return cp && cp.proxyDMId === srcDmId && cp.proxyParagonId === srcParId;
    });
    if (alreadyChild) { this.setStatus('This paragon is already a child of that node.'); return; }
    if (this._wouldCreateCrossDMCycle(targetDm.id, parentId, srcDmId, srcParId)) {
      this.setStatus('Cannot add: would create a cross-DM cycle.'); return;
    }

    this._pushUndo();
    const proxy = createProxyParagon(srcDmId, srcParId);
    targetDm.paragons[proxy.id] = proxy;
    const view = this.project.representation.dmViews[targetDm.id];
    if (view) view.nodePositions[proxy.id] = { x: Math.round(svgPt.x - 80), y: Math.round(svgPt.y - 30) };
    if (parentPar.type === PARAGON_TYPE.UNCONTROLLABLE) parentPar.type = PARAGON_TYPE.AND;
    parentPar.childIds.push(proxy.id);
    this.dmEditor.render();
    this._renderExplorer();
    this._markDirty();
    this.setStatus(`Cross-DM reference added as child of "${parentPar.description}": "${srcPar.description}"`);
  }

  _addStandaloneParagon(type, dm) {
    this._pushUndo();
    const names = {
      [PARAGON_TYPE.AND]: 'New AND Goal',
      [PARAGON_TYPE.OR]: 'New OR Goal',
      [PARAGON_TYPE.UNCONTROLLABLE]: 'New Component'
    };
    const p = createParagon(names[type] || 'New Paragon', type);
    dm.paragons[p.id] = p;
    // Position to the right of all existing nodes
    const view = this.project.representation.dmViews[dm.id];
    if (view) {
      const allPos = Object.values(view.nodePositions);
      const maxX = allPos.length ? Math.max(...allPos.map(q => q.x)) + 190 : 40;
      const midY = allPos.length ? Math.round(allPos.reduce((s, q) => s + q.y, 0) / allPos.length) : 40;
      view.nodePositions[p.id] = { x: maxX, y: midY };
    }
    this._renderExplorer();
    this.dmEditor.render();
    this.dmEditor.selectNode(p.id);
    this._markDirty();
    this.setStatus(`Added standalone ${type} paragon`);
  }

  _addParagonChildTo(parentId, type, dm) {
    this._pushUndo();
    const names = {
      [PARAGON_TYPE.AND]: 'New AND Goal',
      [PARAGON_TYPE.OR]: 'New OR Goal',
      [PARAGON_TYPE.UNCONTROLLABLE]: 'New Component'
    };
    const child = createParagon(names[type] || 'New Paragon', type);
    dm.paragons[child.id] = child;
    const parent = dm.paragons[parentId];
    if (parent.type === PARAGON_TYPE.UNCONTROLLABLE) parent.type = PARAGON_TYPE.AND;
    parent.childIds.push(child.id);

    // Auto-position below parent
    const view = this.project.representation.dmViews[dm.id];
    if (view) {
      const parentPos = view.nodePositions[parentId] || { x: 0, y: 0 };
      const siblings = dm.paragons[parentId].childIds.length;
      view.nodePositions[child.id] = {
        x: parentPos.x + (siblings - 1) * 190,
        y: parentPos.y + 90
      };
    }

    this._renderExplorer();
    this.dmEditor.render();
    this.dmEditor.selectNode(child.id);
    this._markDirty();
    this.setStatus(`Added ${type} paragon child`);
  }

  _removeParagonChild(parent, childId, dm) {
    this._pushUndo();
    // Remove from parent
    parent.childIds = parent.childIds.filter(id => id !== childId);
    // Remove child and all descendants
    const removeDescendants = (id) => {
      const p = dm.paragons[id];
      if (!p) return;
      for (const cid of p.childIds) removeDescendants(cid);
      delete dm.paragons[id];
      if (this.project.representation.dmViews[dm.id]) {
        delete this.project.representation.dmViews[dm.id].nodePositions[id];
      }
    };
    removeDescendants(childId);
    this._renderExplorer();
    this.dmEditor.render();
    this.onDMNodeSelected(dm.paragons[parent.id] ? dm.paragons[parent.id] : null, dm);
    this._markDirty();
  }

  /** Delete a single paragon, leaving its children as standalone / connected to other parents. */
  _deleteParagonOnly(nodeId, dm) {
    this._pushUndo();
    // Detach from all parents
    for (const p of Object.values(dm.paragons)) {
      if (p.childIds.includes(nodeId)) p.childIds = p.childIds.filter(id => id !== nodeId);
    }
    // Delete the node
    delete dm.paragons[nodeId];
    const view = this.project.representation.dmViews[dm.id];
    if (view) delete view.nodePositions[nodeId];
    // Update rootId if needed
    if (dm.rootId === nodeId) {
      const childSet = new Set();
      for (const p of Object.values(dm.paragons)) for (const c of p.childIds) childSet.add(c);
      const roots = Object.keys(dm.paragons).filter(id => !childSet.has(id));
      dm.rootId = roots[0] || null;
    }
    this.dmEditor.selectNode(null);
    this.dmEditor.render();
    this._renderExplorer();
    this._markDirty();
    this.setStatus('Paragon deleted.');
  }

  /**
   * Delete a paragon and any descendants that have no parents outside the deleted set.
   * A descendant is deleted only if ALL its parents are also being deleted.
   */
  _deleteParagonWithChildren(nodeId, dm) {
    this._pushUndo();
    // Build parent map
    const parentMap = {};
    for (const [id, p] of Object.entries(dm.paragons)) {
      for (const cid of p.childIds) {
        if (!parentMap[cid]) parentMap[cid] = [];
        parentMap[cid].push(id);
      }
    }
    // Grow toDelete: a child joins if ALL its parents are already in the set
    const toDelete = new Set([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of toDelete) {
        const p = dm.paragons[id];
        if (!p) continue;
        for (const cid of p.childIds) {
          if (toDelete.has(cid)) continue;
          if ((parentMap[cid] || []).every(pid => toDelete.has(pid))) {
            toDelete.add(cid); changed = true;
          }
        }
      }
    }
    // Remove deleted nodes from surviving parents' childIds
    for (const p of Object.values(dm.paragons)) {
      if (!toDelete.has(p.id)) p.childIds = p.childIds.filter(id => !toDelete.has(id));
    }
    // Delete all collected nodes
    const view = this.project.representation.dmViews[dm.id];
    for (const id of toDelete) {
      delete dm.paragons[id];
      if (view) delete view.nodePositions[id];
    }
    // Update rootId if needed
    if (toDelete.has(dm.rootId)) {
      const childSet = new Set();
      for (const p of Object.values(dm.paragons)) for (const c of p.childIds) childSet.add(c);
      const roots = Object.keys(dm.paragons).filter(id => !childSet.has(id));
      dm.rootId = roots[0] || null;
    }
    const n = toDelete.size;
    this.dmEditor.selectNode(null);
    this.dmEditor.render();
    this._renderExplorer();
    this._markDirty();
    this.setStatus(`Deleted ${n} paragon${n !== 1 ? 's' : ''}.`);
  }

  _dmAutoLayout() {
    if (this.dmEditor) {
      this.dmEditor.autoLayout();
      this.dmEditor.render();
    }
  }

  /** Run the same auto-layout algorithm on the DM shown in the Impact View. */
  _ivAutoLayout() {
    const iv = this.impactView;
    if (!iv || !iv.selectedDMId || !this.dmEditor) return;
    const dm   = this.project.model.dependencyModels[iv.selectedDMId];
    const view = this.project.representation.dmViews[iv.selectedDMId];
    if (!dm || !view) return;
    // Temporarily point dmEditor at the IV's DM so we reuse the identical algorithm
    const prevDM   = this.dmEditor.dm;
    const prevView = this.dmEditor.view;
    this.dmEditor.dm   = dm;
    this.dmEditor.view = view;
    this.dmEditor.autoLayout();
    this.dmEditor.dm   = prevDM;
    this.dmEditor.view = prevView;
    // Reset IV zoom/pan so the newly laid-out nodes are auto-fitted
    iv._dmZoom = null;
    iv.render();
  }

  _toggleImpactSimulation() {
    if (!this.dmEditor || !this.dmEditor.dm) {
      this.setStatus('Select a dependency model first.'); return;
    }
    this._impactSimActive = !this._impactSimActive;
    if (this._impactSimActive) {
      // Gather all ActivityImpacts from all playbook processes
      const overrides = {};
      const impactedIds = new Set();
      for (const proc of Object.values(this.project.model.processes)) {
        for (const impact of (proc.activityImpacts || [])) {
          if (impact.paragonId) {
            overrides[impact.paragonId] = impact.newValue;
            impactedIds.add(impact.paragonId);
          }
        }
      }
      if (impactedIds.size === 0) {
        this._impactSimActive = false;
        this.setStatus('No activity impacts defined in any playbook.');
        return;
      }
      this.dmEditor.setImpactSimulation(overrides, impactedIds);
      this.setStatus(`Impact simulation: ${impactedIds.size} paragon(s) affected. Nodes with orange border are directly impacted.`);
    } else {
      this.dmEditor.clearImpactSimulation();
      this.setStatus('Impact simulation cleared.');
    }
    this._renderViewToolbar();
  }

  _addRole(explicitOrgId) {
    const orgs = Object.values(this.project.model.organisations);
    if (orgs.length === 0) { this.setStatus('Create an organisation first.'); return; }

    const commit = (oid, name) => {
      if (!name.trim()) return;
      this._pushUndo();
      const role = createRole(name.trim());
      this.project.model.roles[role.id] = role;
      const org = this.project.model.organisations[oid];
      if (org) org.roleIds.push(role.id);
      this._renderExplorer();
      this._markDirty();
      this.setStatus(`Created role: ${role.name}`);
    };

    // Single org or explicit target — just ask for the name
    if (explicitOrgId || orgs.length === 1) {
      const oid = explicitOrgId || orgs[0].id;
      this.showInputModal('New Role', 'Enter role name:', 'Responder', name => commit(oid, name));
      return;
    }

    // Multiple orgs — ask for org + name together
    const opts = orgs.map(o => `<option value="${this._esc(o.id)}">${this._esc(o.name)}</option>`).join('');
    this.showModal('Add Role',
      `<div class="prop-row"><label class="prop-label">Organisation</label>
         <select id="role-org" style="width:100%">${opts}</select></div>
       <div class="prop-row"><label class="prop-label">Role Name</label>
         <input id="role-name" type="text" value="Responder" style="width:100%"></div>`,
      () => commit(document.getElementById('role-org').value,
                   document.getElementById('role-name').value)
    );
  }

  _addOrganisation() {
    this.showInputModal('New Organisation', 'Enter organisation name:', 'Response Team', name => {
      if (!name.trim()) return;
      this._pushUndo();
      const org = createOrganisation(name.trim());
      this.project.model.organisations[org.id] = org;
      this._renderExplorer();
      this._markDirty();
    });
  }

  _addRootProcess(explicitOrgId) {
    const orgs = Object.values(this.project.model.organisations);
    if (orgs.length === 0) { this.setStatus('Create an organisation first.'); return; }

    const commit = (oid, name) => {
      if (!name.trim()) return;
      this._pushUndo();
      const proc = createPlaybookProcess(name.trim());
      this.project.model.processes[proc.id] = proc;
      const org = this.project.model.organisations[oid];
      org.rootProcessIds.push(proc.id);
      this.project.representation.pbViews[proc.id] = createPBView();
      this._renderExplorer();
      this._selectRootProcess(proc.id);
      this._switchTab('pb');
      this._markDirty();
      this.setStatus(`Created playbook: ${proc.name}`);
    };

    // Single org or explicit target — just ask for the name
    if (explicitOrgId || orgs.length === 1) {
      const oid = explicitOrgId || orgs[0].id;
      this.showInputModal('New Playbook', 'Enter playbook name:', 'Incident Response Playbook',
        name => commit(oid, name));
      return;
    }

    // Multiple orgs — ask for org + name together
    const opts = orgs.map(o => `<option value="${this._esc(o.id)}">${this._esc(o.name)}</option>`).join('');
    this.showModal('New Playbook',
      `<div class="prop-row"><label class="prop-label">Organisation</label>
         <select id="pb-org" style="width:100%">${opts}</select></div>
       <div class="prop-row"><label class="prop-label">Playbook Name</label>
         <input id="pb-name" type="text" value="Incident Response Playbook" style="width:100%"></div>`,
      () => commit(document.getElementById('pb-org').value,
                   document.getElementById('pb-name').value)
    );
  }

  _addSubProcess(explicitParentId) {
    if (!this.pbEditor || !this.pbEditor.currentProcessId) {
      this.setStatus('Select a playbook process first.'); return;
    }
    // When called from toolbar: add as child of currentProcessId (current view level).
    // When called from context menu with a nodeId: add as child of that specific node.
    const parentId = explicitParentId || this.pbEditor.currentProcessId;
    const parent = this.project.model.processes[parentId];
    if (!parent) return;

    this.showInputModal('New Activity', 'Enter activity name:', 'New Activity', name => {
      if (!name.trim()) return;
      this._pushUndo();
      const proc = createPlaybookProcess(name.trim());
      this.project.model.processes[proc.id] = proc;
      parent.subProcessIds.push(proc.id);

      // Ensure a pbView exists for the parent so the new child has a position
      if (!this.project.representation.pbViews[parentId]) {
        this.project.representation.pbViews[parentId] = { nodePositions: {}, zoom: 1, panX: 0, panY: 0 };
      }
      const view = this.project.representation.pbViews[parentId];
      const count = parent.subProcessIds.length;
      view.nodePositions[proc.id] = { x: 60 + (count - 1) * 210, y: 60 };

      this._renderExplorer();
      // Stay in current view; if parent was in the current view, it now shows the badge
      this.pbEditor.setProcess(this.pbEditor.currentProcessId);
      this._markDirty();
      this.setStatus(`Added sub-activity "${proc.name}" to "${parent.name}"`);
    });
  }

  _pbAutoLayout() {
    if (!this.pbEditor || !this.pbEditor.currentProcessId) return;
    const proc = this.project.model.processes[this.pbEditor.currentProcessId];
    if (!proc) return;
    const view = this.project.representation.pbViews[this.pbEditor.currentProcessId];
    if (!view) return;
    this.pbEditor._autoLayout(proc, view);
    this.pbEditor.render();
  }

  createConnection(fromId, toId, viewProcessId) {
    // Create an ArtifactStateInstance linking fromId -> toId
    // Create a default artifact/state to hold it
    this._pushUndo();

    // Find or create a default artifact for this playbook
    const viewProc = this.project.model.processes[viewProcessId];
    if (!viewProc) return;

    // Create artifact/state/instance
    const art = createArtifact('Flow');
    const state = createArtifactState('data');
    const inst = createArtifactStateInstance(fromId, toId);

    state.instanceIds.push(inst.id);
    art.stateIds.push(state.id);

    this.project.model.artifacts[art.id] = art;
    this.project.model.artifactStates[state.id] = state;
    this.project.model.artifactStateInstances[inst.id] = inst;

    // Update process references
    const fromProc = this.project.model.processes[fromId];
    const toProc   = this.project.model.processes[toId];
    if (fromProc) fromProc.resultArtifactInStateIds.push(inst.id);
    if (toProc)   toProc.artifactInStateUsedIds.push(inst.id);

    this.pbEditor.render();
    this._markDirty();
    this.setStatus(`Connected ${fromProc ? fromProc.name : '?'} → ${toProc ? toProc.name : '?'}`);
  }

  _deleteConnection(instId) {
    if (!confirm('Delete this connection?')) return;
    this._pushUndo();
    const inst = this.project.model.artifactStateInstances[instId];
    if (inst) {
      // Remove from process refs
      for (const proc of Object.values(this.project.model.processes)) {
        proc.resultArtifactInStateIds = proc.resultArtifactInStateIds.filter(i => i !== instId);
        proc.artifactInStateUsedIds   = proc.artifactInStateUsedIds.filter(i => i !== instId);
      }
      // Remove from artifact states
      for (const st of Object.values(this.project.model.artifactStates)) {
        st.instanceIds = st.instanceIds.filter(i => i !== instId);
      }
      delete this.project.model.artifactStateInstances[instId];
    }
    this.pbEditor.render();
    this._showNoSelection();
    this._markDirty();
  }

  _deleteProcess(procId) {
    if (!confirm('Delete this activity and all its sub-activities?')) return;
    this._pushUndo();
    const removeProc = (id) => {
      const proc = this.project.model.processes[id];
      if (!proc) return;
      for (const sid of proc.subProcessIds) removeProc(sid);
      // Remove connections involving this process
      const instsToRemove = [
        ...proc.resultArtifactInStateIds,
        ...proc.artifactInStateUsedIds
      ];
      for (const instId of instsToRemove) this._deleteConnection(instId);
      // Remove actuators
      for (const actId of proc.resourceIds) delete this.project.model.actuators[actId];
      // Remove ext refs
      // Remove from parent
      for (const p of Object.values(this.project.model.processes)) {
        p.subProcessIds = p.subProcessIds.filter(s => s !== id);
      }
      for (const org of Object.values(this.project.model.organisations)) {
        org.rootProcessIds = org.rootProcessIds.filter(p => p !== id);
      }
      // Remove pb view
      delete this.project.representation.pbViews[id];
      delete this.project.model.processes[id];
    };
    removeProc(procId);
    this.pbEditor && this.pbEditor.render();
    this._renderExplorer();
    this._showNoSelection();
    this._markDirty();
  }

  _addActuatorToProcess(proc) {
    this.showModal('Add Actuator', `
      <div class="prop-row"><label class="prop-label">Name</label>
        <input id="act-name" type="text" value="Analyst" style="width:100%">
      </div>
      <div class="prop-row"><label class="prop-label">Type</label>
        <select id="act-type" style="width:100%">
          <option value="HUMAN">Human</option>
          <option value="MACHINE">Machine</option>
        </select>
      </div>
    `, () => {
      const name = document.getElementById('act-name').value.trim();
      const type = document.getElementById('act-type').value;
      if (!name) return;
      const act = createActuator(name, type);
      this.project.model.actuators[act.id] = act;
      proc.resourceIds.push(act.id);
      this._renderProcessProperties(proc);
      this._markDirty();
    });
  }

  _addActivityImpact(proc) {
    // Build list of all paragons
    const allParagons = Registry.allParagons(this.project);
    const options = Object.values(allParagons)
      .map(p => `<option value="${p.id}">${this._esc(p.description)}</option>`)
      .join('');

    this.showModal('Add Activity Impact', `
      <div class="prop-row"><label class="prop-label">Paragon</label>
        <select id="imp-paragon" style="width:100%">
          <option value="">— Select paragon —</option>${options}
        </select>
      </div>
      <div class="prop-row"><label class="prop-label">New Value</label>
        <input id="imp-value" type="number" min="0" max="1" step="0.01" value="1.0" style="width:100%">
      </div>
    `, () => {
      const paragonId = document.getElementById('imp-paragon').value;
      const newValue = parseFloat(document.getElementById('imp-value').value);
      if (!paragonId) return;
      const impact = createActivityImpact(paragonId, newValue);
      proc.activityImpacts.push(impact);
      this._renderProcessProperties(proc);
      this._markDirty(); this._syncImpactView();
    });
  }

  _addExternalRef(proc) {
    this.showModal('Add External Reference', `
      <div class="prop-row"><label class="prop-label">Name</label>
        <input id="ref-name" type="text" placeholder="Reference name or URL" style="width:100%">
      </div>
      <div class="prop-row"><label class="prop-label">Type</label>
        <select id="ref-type" style="width:100%">
          <option value="BEST_PRACTICE">Best Practice</option>
          <option value="POLICY">Policy</option>
          <option value="REGULATION">Regulation</option>
        </select>
      </div>
    `, () => {
      const name = document.getElementById('ref-name').value.trim();
      const type = document.getElementById('ref-type').value;
      const ref = createExternalReference(name, type);
      proc.externalReferences.push(ref);
      this._renderProcessProperties(proc);
      this._markDirty();
    });
  }

  _addActivityToOrg(orgId) {
    const org = this.project.model.organisations[orgId];
    if (!org) return;
    if (!org.roleIds.length) return;
  }

  /* ---- SYMBIOSIS operations ---- */
  _initSymbiosis() {
    if (!this.project.model.symbiosis) {
      this._pushUndo();
      this.project.model.symbiosis = createSymbiosis();
      this._renderSymbiosis();
      this._renderExplorer();
      this._markDirty();
    }
  }

  _addBusinessObjective() {
    if (!this.project.model.symbiosis) this._initSymbiosis();
    this.showModal('Add Business Objective', `
      <div class="prop-row"><label class="prop-label">Scope</label><input id="bo-scope" type="text" style="width:100%"></div>
      <div class="prop-row"><label class="prop-label">Purpose</label><input id="bo-purpose" type="text" style="width:100%"></div>
      <div class="prop-row"><label class="prop-label">Viewpoint</label><input id="bo-viewpoint" type="text" style="width:100%"></div>
      <div class="prop-row"><label class="prop-label">Context</label><input id="bo-context" type="text" style="width:100%"></div>
    `, () => {
      const bo = createBusinessObjective();
      bo.scope = document.getElementById('bo-scope').value;
      bo.purpose = document.getElementById('bo-purpose').value;
      bo.viewpoint = document.getElementById('bo-viewpoint').value;
      bo.context = document.getElementById('bo-context').value;
      this.project.model.symbiosis.businessObjectives[bo.id] = bo;
      this._renderSymbiosis();
      this._markDirty();
    });
  }

  _addSMG() {
    if (!this.project.model.symbiosis) this._initSymbiosis();
    this.showModal('Add Security Measurement Goal', `
      <div class="prop-row"><label class="prop-label">Scope</label><input id="smg-scope" type="text" style="width:100%"></div>
      <div class="prop-row"><label class="prop-label">Purpose</label><input id="smg-purpose" type="text" style="width:100%"></div>
      <div class="prop-row"><label class="prop-label">Focus</label><input id="smg-focus" type="text" style="width:100%"></div>
      <div class="prop-row"><label class="prop-label">Criteria</label><input id="smg-criteria" type="text" style="width:100%"></div>
    `, () => {
      const smg = createSecurityMeasurementGoal();
      smg.scope = document.getElementById('smg-scope').value;
      smg.purpose = document.getElementById('smg-purpose').value;
      smg.focus = document.getElementById('smg-focus').value;
      smg.criteria = document.getElementById('smg-criteria').value;
      this.project.model.symbiosis.securityMeasurementGoals[smg.id] = smg;
      this._renderSymbiosis();
      this._markDirty();
    });
  }

  _addSecurityMetric() {
    if (!this.project.model.symbiosis) this._initSymbiosis();
    this.showModal('Add Security Metric', `
      <div class="prop-row"><label class="prop-label">Description</label><textarea id="sm-desc" style="width:100%;height:60px"></textarea></div>
      <div class="prop-row"><label class="prop-label">Method</label><input id="sm-method" type="text" style="width:100%"></div>
      <div class="prop-row"><label class="prop-label">Interpretation</label><input id="sm-interp" type="text" style="width:100%"></div>
    `, () => {
      const sm = createSecurityMetric();
      sm.description = document.getElementById('sm-desc').value;
      sm.method = document.getElementById('sm-method').value;
      sm.interpretation = document.getElementById('sm-interp').value;
      this.project.model.symbiosis.securityMetrics[sm.id] = sm;
      this._renderSymbiosis();
      this._markDirty();
    });
  }

  /* ---- Context Menus ---- */

  showDMContextMenu(e, nodeId, dm) {
    const items = [];
    if (nodeId && dm) {
      const p = dm.paragons[nodeId];
      // Proxy node: special limited menu
      if (p && p.proxyDMId && p.proxyParagonId) {
        const extDM  = this.project.model.dependencyModels[p.proxyDMId];
        const extPar = extDM && extDM.paragons[p.proxyParagonId];
        const dmLabel = extDM ? extDM.name : p.proxyDMId;
        items.push({ label: `\u2197 Open in "${dmLabel}"`, fn: () => this._navigateToProxySource(p) });
        items.push({ sep: true });
        items.push({ label: '\u2702 Remove cross-DM reference', danger: true,
          fn: () => this._deleteParagonOnly(nodeId, dm) });
        this._showContextMenu(e, items);
        return;
      }

      items.push({ label: `Edit: ${p ? p.description.substring(0,20) : ''}`, fn: () => {} });
      items.push({ sep: true });
      items.push({ label: '+ AND child',          fn: () => this._addParagonChildTo(nodeId, PARAGON_TYPE.AND, dm) });
      items.push({ label: '+ OR child',           fn: () => this._addParagonChildTo(nodeId, PARAGON_TYPE.OR, dm) });
      items.push({ label: '+ Leaf (Uncontrollable)', fn: () => this._addParagonChildTo(nodeId, PARAGON_TYPE.UNCONTROLLABLE, dm) });
      items.push({ label: '\u{1F310} Add cross-DM child\u2026', fn: () => this._addCrossDMChild(nodeId, dm) });

      // Connect to a different parent
      items.push({ sep: true });
      items.push({ label: '🔗 Make child of…', fn: () => {
        const eligible = Object.values(dm.paragons).filter(p2 =>
          p2.id !== nodeId && !ModelValidator.wouldCreateCycle(p2.id, nodeId, dm.paragons)
        );
        if (!eligible.length) { this.setStatus('No eligible parents (all would create a cycle).'); return; }
        const opts = eligible.map(p2 =>
          `<option value="${this._esc(p2.id)}">${this._esc(p2.description)}</option>`).join('');
        this.showModal('Make Child Of',
          `<div class="prop-row"><label class="prop-label">Parent Paragon</label>
             <select id="par-parent" style="width:100%">${opts}</select></div>`,
          () => {
            const parentId = document.getElementById('par-parent').value;
            if (!parentId) return;
            this._pushUndo();
            dm.paragons[parentId].childIds.push(nodeId);
            this.dmEditor.render(); this._renderExplorer(); this._markDirty();
          }
        );
      }});

      // Disconnect from all parents (make standalone)
      const parents = Object.values(dm.paragons).filter(p2 => p2.childIds.includes(nodeId));
      if (parents.length > 0) {
        items.push({ label: '✂ Disconnect from parent', fn: () => {
          this._pushUndo();
          for (const par of parents) par.childIds = par.childIds.filter(id => id !== nodeId);
          this.dmEditor.render(); this._renderExplorer(); this._markDirty();
        }});
      }

      if (p && p.childIds.length > 0) {
        items.push({ sep: true });
        const isCollapsed = this.dmEditor && this.dmEditor._collapsed.has(nodeId);
        items.push({ label: isCollapsed ? '▶ Expand Children' : '▼ Collapse Children', fn: () => {
          if (!this.dmEditor) return;
          if (isCollapsed) this.dmEditor._collapsed.delete(nodeId);
          else this.dmEditor._collapsed.add(nodeId);
          this.dmEditor.render();
        }});
      }

      items.push({ sep: true });
      items.push({ label: '🗑 Delete node', danger: true,
        fn: () => this._deleteParagonOnly(nodeId, dm) });
      items.push({ label: '🗑 Delete with children', danger: true,
        fn: () => this._deleteParagonWithChildren(nodeId, dm) });

    } else {
      items.push({ label: '+ Dependency Model', fn: () => this._addDependencyModel() });
      items.push({ label: 'Auto Layout', fn: () => this._dmAutoLayout() });
      items.push({ label: 'Expand All', fn: () => {
        if (this.dmEditor) { this.dmEditor._collapsed.clear(); this.dmEditor.render(); }
      }});
      items.push({ label: 'Collapse All', fn: () => {
        if (!this.dmEditor || !this.dmEditor.dm) return;
        const collapseAll = (id) => {
          const q = this.dmEditor.dm.paragons[id];
          if (q && q.childIds.length > 0) { this.dmEditor._collapsed.add(id); q.childIds.forEach(c => collapseAll(c)); }
        };
        this.dmEditor._collapsed.clear();
        for (const id of Object.keys(this.dmEditor.dm.paragons)) collapseAll(id);
        this.dmEditor.render();
      }});
    }
    this._showContextMenu(e, items);
  }

  showPBContextMenu(e, nodeId, connId, viewProcessId) {
    const items = [];
    if (connId) {
      items.push({ label: 'Delete Connection', danger: true, fn: () => this._deleteConnection(connId) });
    } else if (nodeId) {
      const proc = this.project.model.processes[nodeId];
      items.push({ label: `Edit: ${proc ? proc.name.substring(0,20) : ''}`, fn: () => this.pbEditor && this.pbEditor.selectProcess(nodeId) });
      if (proc && proc.subProcessIds.length > 0) {
        items.push({ label: '▶ Drill Down', fn: () => this.pbEditor && this.pbEditor.drillDown(nodeId) });
      }
      items.push({ sep: true });
      items.push({ label: '+ Sub-activity', fn: () => {
        if (this.pbEditor) this._addSubProcess(nodeId);
      }});
      items.push({ sep: true });
      items.push({ label: '✓ Mark Complete', fn: () => {
        const p = this.project.model.processes[nodeId];
        if (p) { p.status = STATUS_ENUM.COMPLETED; this.pbEditor && this.pbEditor.render(); this._markDirty(); }
      }});
      items.push({ label: '○ Mark Unspecified', fn: () => {
        const p = this.project.model.processes[nodeId];
        if (p) { p.status = STATUS_ENUM.UNSPECIFIED; this.pbEditor && this.pbEditor.render(); this._markDirty(); }
      }});
      items.push({ sep: true });
      items.push({ label: '🗑 Delete Activity', danger: true, fn: () => this._deleteProcess(nodeId) });
    } else {
      items.push({ label: '+ Activity', fn: () => this._addSubProcess() });
      items.push({ label: 'Auto Layout', fn: () => this._pbAutoLayout() });
    }
    this._showContextMenu(e, items);
  }

  _showContextMenu(e, items) {
    const menu = this.els['context-menu'];
    const itemsEl = this.els['context-menu-items'];
    itemsEl.innerHTML = '';

    for (const item of items) {
      if (item.sep) {
        const li = document.createElement('li');
        li.className = 'ctx-item ctx-sep';
        itemsEl.appendChild(li);
        continue;
      }
      const li = document.createElement('li');
      li.className = 'ctx-item' + (item.danger ? ' ctx-danger' : '');
      li.textContent = item.label;
      if (item.fn) {
        li.addEventListener('click', () => {
          menu.classList.add('hidden');
          item.fn();
        });
      }
      itemsEl.appendChild(li);
    }

    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.remove('hidden');

    // Keep menu in viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (e.clientX - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (e.clientY - rect.height) + 'px';
  }

  /* ---- Inline Editing ---- */

  editParagonInline(paragonId, dm) {
    const paragon = dm.paragons[paragonId];
    if (!paragon) return;
    this.dmEditor.selectNode(paragonId);
  }

  editProcessInline(procId) {
    this.pbEditor && this.pbEditor.selectProcess(procId);
  }

  /* ---- Metrics View ---- */

  _renderMetrics() {
    const el = this.els['metrics-content'];
    el.innerHTML = '';

    // Build CiO overrides from the selected scope (all activities or a specific playbook)
    const cioOverrides = this._buildImpactOverrides(this._metricsScope);
    const report = Metrics.getMetricsReport(this.project, cioOverrides);

    if (report.dmReports.length === 0) {
      el.innerHTML = '<p class="no-selection" style="margin-top:40px">No dependency models. Create a dependency model to compute metrics.</p>';
      return;
    }

    // Pre-compute all ActivityImpact overrides for planned-breach detection (always uses all)
    const allImpactOv = this._buildImpactOverrides(null);

    for (const { dm, rootProbability, paragons } of report.dmReports) {
      const section = document.createElement('div');
      section.className = 'metrics-section';

      const h3 = document.createElement('h3');
      h3.textContent = dm.name;
      section.appendChild(h3);

      // Summary stats
      const stats = document.createElement('div');
      stats.className = 'stat-cards';
      stats.appendChild(this._statCard(Metrics.formatProb(rootProbability), 'System Goal', Metrics.probToColor(rootProbability)));
      stats.appendChild(this._statCard(paragons.length, 'Paragons', '#a855f7'));
      stats.appendChild(this._statCard(paragons.filter(p => p.isLeaf).length, 'Leaf Components', '#8899b0'));
      section.appendChild(stats);

      // Table
      const table = document.createElement('table');
      table.className = 'metrics-table';
      table.innerHTML = `
        <thead><tr>
          <th>Paragon</th>
          <th>Type</th>
          <th>Probability</th>
          <th>CiO</th>
          <th>Critical Threshold Alert</th>
        </tr></thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector('tbody');
      for (const row of paragons) {
        const tr = document.createElement('tr');
        const indent = '&nbsp;&nbsp;'.repeat(row.depth);
        const par = dm.paragons[row.id];
        // Resolve proxy paragon description to its source
        let displayDesc = row.description;
        if (par && par.proxyDMId && par.proxyParagonId) {
          const srcDM  = this.project.model.dependencyModels[par.proxyDMId];
          const srcPar = srcDM && srcDM.paragons[par.proxyParagonId];
          displayDesc = srcPar ? `\u2197 ${srcPar.description} (${srcDM.name})` : row.description;
        }
        const parCT = par && par.criticalThreshold != null ? par.criticalThreshold : null;
        let ctAlert;
        if (parCT === null) {
          ctAlert = '<span style="color:#5a6880;font-size:10px">—</span>';
        } else {
          const simProb   = Metrics.computeProbability(row.id, dm.paragons, allImpactOv, this.project);
          const isCurrent = row.computedProbability < parCT;
          const isPlanned = !isCurrent && simProb < parCT;
          const mode      = (par.notifyMode === 'REQUEST_APPROVAL') ? 'Approval' : 'Notify';
          const stkCount  = (par.stakeholders || []).length;
          const stkNote   = stkCount > 0 ? ` (${stkCount} stakeholder${stkCount > 1 ? 's' : ''})` : '';
          if (isCurrent) {
            ctAlert = `<span style="color:#e74c3c;font-size:10px;font-weight:bold">⚠ BELOW CT ${parCT} — ${mode}${stkNote}</span>`;
          } else if (isPlanned) {
            ctAlert = `<span style="color:#f39c12;font-size:10px;font-weight:bold">⚠ Planned breach CT ${parCT} — ${mode}${stkNote}</span>`;
          } else {
            ctAlert = `<span style="color:#2ecc71;font-size:10px">CT ${parCT} OK</span>`;
          }
        }
        tr.innerHTML = `
          <td>${indent}${this._esc(displayDesc)}</td>
          <td><span class="type-badge type-${row.type}">${row.type}</span></td>
          <td>
            <div class="prob-bar-wrap">
              <div class="prob-bar-bg"><div class="prob-bar-fill" style="width:${row.computedProbability*100}%;background:${Metrics.probToColor(row.computedProbability)}"></div></div>
              <span class="prob-num">${Metrics.formatProb(row.computedProbability)}</span>
            </div>
          </td>
          <td><span class="${row.cio > 0 ? 'cio-pos' : (row.cio < 0 ? 'cio-neg' : 'cio-zero')}">${Metrics.formatCiO(row.cio)}</span></td>
          <td>${ctAlert}</td>
        `;
        tr.classList.add('metrics-row-clickable');
        tr.title = 'Click to view properties';
        tr.addEventListener('click', () => {
          tr.closest('tbody').querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
          tr.classList.add('selected');
          // For proxy paragons show source paragon properties; for normal paragons show directly
          if (par && par.proxyDMId && par.proxyParagonId) {
            const srcDM  = this.project.model.dependencyModels[par.proxyDMId];
            const srcPar = srcDM && srcDM.paragons[par.proxyParagonId];
            if (srcPar) this._renderParagonProperties(srcPar, srcDM);
          } else if (par) {
            this._renderParagonProperties(par, dm);
          }
        });
        tbody.appendChild(tr);
      }
      section.appendChild(table);
      el.appendChild(section);
    }

    // Activity Impact section
    if (report.activityReports.length > 0) {
      const section = document.createElement('div');
      section.className = 'metrics-section';
      const h3 = document.createElement('h3');
      h3.textContent = 'Activity Impacts';
      section.appendChild(h3);

      const table = document.createElement('table');
      table.className = 'metrics-table';
      table.innerHTML = `
        <thead><tr><th>Activity</th><th>Targeted Paragon</th><th>P before</th><th>P after</th><th>CiO (paragon)</th><th>CiO (root)</th></tr></thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector('tbody');
      for (const { process: proc, details, total } of report.activityReports) {
        for (const d of details) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${this._esc(proc.name)}</td>
            <td>${this._esc(d.paragonDesc)}</td>
            <td>${Metrics.formatProb(d.originalProbability)}</td>
            <td>${Metrics.formatProb(d.newValue)}</td>
            <td><span class="${d.paragonCiO > 0 ? 'cio-pos' : (d.paragonCiO < 0 ? 'cio-neg' : 'cio-zero')}" title="CiO(paragon) = P_after − P_before = ${Metrics.formatProb(d.newValue)} − ${Metrics.formatProb(d.originalProbability)}">${Metrics.formatCiO(d.paragonCiO)}</span></td>
            <td><span class="${d.delta > 0 ? 'cio-pos' : (d.delta < 0 ? 'cio-neg' : 'cio-zero')}" title="Propagated change in root goal probability">${Metrics.formatCiO(d.delta)}</span></td>
          `;
          tr.classList.add('metrics-row-clickable');
          tr.title = 'Click to view activity properties';
          tr.addEventListener('click', () => {
            tr.closest('tbody').querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
            tr.classList.add('selected');
            this._renderProcessProperties(proc);
          });
          tbody.appendChild(tr);
        }
      }
      section.appendChild(table);
      el.appendChild(section);
    }
  }

  _statCard(value, label, color) {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const valEl = document.createElement('div');
    valEl.className = 'stat-val';
    valEl.textContent = value;
    valEl.style.color = color;
    const labelEl = document.createElement('div');
    labelEl.className = 'stat-label';
    labelEl.textContent = label;
    card.appendChild(valEl);
    card.appendChild(labelEl);
    return card;
  }

  /* ---- SYMBIOSIS View ---- */

  _renderSymbiosis() {
    const el = this.els['symbiosis-content'];
    el.innerHTML = '';

    if (!this.project.model.symbiosis) {
      const p = document.createElement('p');
      p.className = 'no-selection';
      p.style.marginTop = '40px';
      p.textContent = 'No SYMBIOSIS model. Click "Init SYMBIOSIS" in the toolbar.';
      el.appendChild(p);
      return;
    }

    const s = this.project.model.symbiosis;

    const addGrid = (title, items, fields) => {
      const section = document.createElement('div');
      section.className = 'metrics-section';
      const h3 = document.createElement('h3');
      h3.textContent = title;
      section.appendChild(h3);
      const grid = document.createElement('div');
      grid.className = 'symb-grid';
      for (const item of Object.values(items)) {
        const card = document.createElement('div');
        card.className = 'symb-card';
        const body = document.createElement('div');
        body.className = 'symb-card-body';
        for (const [label, key] of fields) {
          if (item[key]) {
            const f = document.createElement('div');
            f.className = 'field';
            f.innerHTML = `<strong>${label}:</strong> ${this._esc(item[key])}`;
            body.appendChild(f);
          }
        }
        card.appendChild(body);
        grid.appendChild(card);
      }
      section.appendChild(grid);
      el.appendChild(section);
    };

    addGrid('Business Objectives', s.businessObjectives, [
      ['Scope','scope'],['Purpose','purpose'],['Viewpoint','viewpoint'],['Context','context']
    ]);
    addGrid('Security Measurement Goals', s.securityMeasurementGoals, [
      ['Scope','scope'],['Purpose','purpose'],['Focus','focus'],['Criteria','criteria']
    ]);
    addGrid('Security Metrics', s.securityMetrics, [
      ['Description','description'],['Method','method'],['Interpretation','interpretation']
    ]);
  }

  /* ---- MITRE View ---- */

  _renderMitreView() {
    const el = document.getElementById('mitre-content');
    if (!el) return;
    el.innerHTML = '';

    // Collect all techniques and defenses from all processes
    const attackMap = new Map(); // techniqueId -> {technique, processes:[]}
    const defendMap = new Map();

    for (const proc of Object.values(this.project.model.processes)) {
      for (const t of (proc.mitreTechniques || [])) {
        if (!attackMap.has(t.techniqueId)) {
          attackMap.set(t.techniqueId, { ...t, processes: [] });
        }
        attackMap.get(t.techniqueId).processes.push(proc);
      }
      for (const d of (proc.mitreDefend || [])) {
        if (!defendMap.has(d.techniqueId)) {
          defendMap.set(d.techniqueId, { ...d, processes: [] });
        }
        defendMap.get(d.techniqueId).processes.push(proc);
      }
    }

    if (attackMap.size === 0 && defendMap.size === 0) {
      el.innerHTML = '<p style="color:var(--text-secondary);font-style:italic">No MITRE ATT&CK or D3FEND mappings found in this project. Add mitreTechniques or mitreDefend to playbook activities.</p>';
      return;
    }

    // Navigator integration banner
    const banner = document.createElement('div');
    banner.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:12px 16px;margin-bottom:20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    const bannerText = document.createElement('span');
    bannerText.style.cssText = 'font-size:12px;color:var(--text-secondary);flex:1;min-width:200px';
    bannerText.innerHTML = `<strong style="color:var(--text-primary)">${attackMap.size}</strong> ATT&CK technique${attackMap.size !== 1 ? 's' : ''} &nbsp;&bull;&nbsp; <strong style="color:var(--text-primary)">${defendMap.size}</strong> D3FEND countermeasure${defendMap.size !== 1 ? 's' : ''} mapped in this project`;
    banner.appendChild(bannerText);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'tool-btn';
    exportBtn.textContent = 'Export Navigator Layer';
    exportBtn.title = 'Download ATT&CK Navigator layer JSON';
    exportBtn.style.cssText = 'font-size:11px;padding:4px 10px';
    exportBtn.addEventListener('click', () => this._exportNavigatorLayer());
    banner.appendChild(exportBtn);

    const navBtn = document.createElement('button');
    navBtn.className = 'tool-btn';
    navBtn.textContent = 'Open ATT&CK Navigator';
    navBtn.title = 'Open MITRE ATT&CK Navigator in a new tab';
    navBtn.style.cssText = 'font-size:11px;padding:4px 10px';
    navBtn.addEventListener('click', () => window.open('https://mitre-attack.github.io/attack-navigator/', '_blank'));
    banner.appendChild(navBtn);

    const d3Btn = document.createElement('button');
    d3Btn.className = 'tool-btn';
    d3Btn.textContent = 'Open D3FEND';
    d3Btn.title = 'Open MITRE D3FEND in a new tab';
    d3Btn.style.cssText = 'font-size:11px;padding:4px 10px';
    d3Btn.addEventListener('click', () => window.open('https://d3fend.mitre.org/', '_blank'));
    banner.appendChild(d3Btn);

    el.appendChild(banner);

    // ATT&CK Section
    if (attackMap.size > 0) {
      const section = document.createElement('div');
      section.style.marginBottom = '24px';
      const header = document.createElement('h3');
      header.style.cssText = 'margin:0 0 12px 0;color:var(--accent);font-size:14px;font-family:var(--font-mono);letter-spacing:0.5px';
      header.textContent = `// MITRE ATT&CK Techniques (${attackMap.size})`;
      section.appendChild(header);

      // Group by tactic
      const byTactic = new Map();
      for (const [, entry] of attackMap) {
        const tactic = entry.tactic || 'Unknown';
        if (!byTactic.has(tactic)) byTactic.set(tactic, []);
        byTactic.get(tactic).push(entry);
      }

      for (const [tactic, entries] of byTactic) {
        const tacticDiv = document.createElement('div');
        tacticDiv.style.marginBottom = '16px';
        const tacticHeader = document.createElement('div');
        tacticHeader.style.cssText = 'font-size:11px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--border)';
        tacticHeader.textContent = tactic;
        tacticDiv.appendChild(tacticHeader);

        for (const entry of entries) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:baseline;gap:8px;padding:4px 0;font-size:12px';
          const link = document.createElement('a');
          link.href = entry.url || `https://attack.mitre.org/techniques/${entry.techniqueId.replace('.', '/')}/`;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = entry.techniqueId;
          link.style.cssText = 'color:var(--accent);text-decoration:none;font-weight:700;font-family:var(--font-mono);white-space:nowrap;min-width:80px';
          const name = document.createElement('span');
          name.textContent = entry.techniqueName;
          name.style.cssText = 'color:var(--text-primary);flex:1';
          const count = document.createElement('span');
          count.textContent = `${entry.processes.length} activit${entry.processes.length === 1 ? 'y' : 'ies'}`;
          count.style.cssText = 'color:var(--text-secondary);font-size:10px;white-space:nowrap';
          row.appendChild(link);
          row.appendChild(name);
          row.appendChild(count);

          // Process list on hover/click
          row.title = entry.processes.map(p => p.name).join(', ');
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => {
            if (entry.processes.length > 0) {
              const proc = entry.processes[0];
              // Navigate to the process in PB view
              const rootProc = this._findRootProcessFor(proc.id);
              if (rootProc) {
                this._selectRootProcess(rootProc);
                this._switchTab('pb');
              }
            }
          });

          tacticDiv.appendChild(row);
        }
        section.appendChild(tacticDiv);
      }
      el.appendChild(section);
    }

    // D3FEND Section
    if (defendMap.size > 0) {
      const section = document.createElement('div');
      const header = document.createElement('h3');
      header.style.cssText = 'margin:0 0 12px 0;color:#22c55e;font-size:14px;font-family:var(--font-mono);letter-spacing:0.5px';
      header.textContent = `// MITRE D3FEND Countermeasures (${defendMap.size})`;
      section.appendChild(header);

      // Group by tactic
      const byTactic = new Map();
      for (const [, entry] of defendMap) {
        const tactic = entry.tactic || 'Unknown';
        if (!byTactic.has(tactic)) byTactic.set(tactic, []);
        byTactic.get(tactic).push(entry);
      }

      for (const [tactic, entries] of byTactic) {
        const tacticDiv = document.createElement('div');
        tacticDiv.style.marginBottom = '16px';
        const tacticHeader = document.createElement('div');
        tacticHeader.style.cssText = 'font-size:11px;color:var(--text-secondary);font-weight:700;text-transform:uppercase;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--border)';
        tacticHeader.textContent = tactic;
        tacticDiv.appendChild(tacticHeader);

        for (const entry of entries) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:baseline;gap:8px;padding:4px 0;font-size:12px';
          const link = document.createElement('a');
          link.href = entry.url || '#';
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = entry.techniqueId;
          link.style.cssText = 'color:#22c55e;text-decoration:none;font-weight:700;font-family:var(--font-mono);white-space:nowrap;min-width:80px';
          const name = document.createElement('span');
          name.textContent = entry.techniqueName;
          name.style.cssText = 'color:var(--text-primary);flex:1';
          const count = document.createElement('span');
          count.textContent = `${entry.processes.length} activit${entry.processes.length === 1 ? 'y' : 'ies'}`;
          count.style.cssText = 'color:var(--text-secondary);font-size:10px;white-space:nowrap';
          row.appendChild(link);
          row.appendChild(name);
          row.appendChild(count);

          row.title = entry.processes.map(p => p.name).join(', ');
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => {
            if (entry.processes.length > 0) {
              const proc = entry.processes[0];
              const rootProc = this._findRootProcessFor(proc.id);
              if (rootProc) {
                this._selectRootProcess(rootProc);
                this._switchTab('pb');
              }
            }
          });

          tacticDiv.appendChild(row);
        }
        section.appendChild(tacticDiv);
      }
      el.appendChild(section);
    }
  }

  /** Find the root process ID that contains a given process (for navigation) */
  _findRootProcessFor(processId) {
    for (const org of Object.values(this.project.model.organisations)) {
      for (const rootId of org.rootProcessIds) {
        if (rootId === processId) return rootId;
        if (this._isDescendantOf(processId, rootId)) return rootId;
      }
    }
    return null;
  }

  _isDescendantOf(targetId, parentId) {
    const parent = this.project.model.processes[parentId];
    if (!parent) return false;
    for (const subId of (parent.subProcessIds || [])) {
      if (subId === targetId) return true;
      if (this._isDescendantOf(targetId, subId)) return true;
    }
    return false;
  }

  /** Export an ATT&CK Navigator layer JSON for all techniques in this project */
  _exportNavigatorLayer() {
    const techniques = [];
    const seen = new Set();

    for (const proc of Object.values(this.project.model.processes)) {
      for (const t of (proc.mitreTechniques || [])) {
        if (seen.has(t.techniqueId)) continue;
        seen.add(t.techniqueId);
        techniques.push({
          techniqueID: t.techniqueId,
          tactic: (t.tactic || '').toLowerCase().replace(/\s+/g, '-'),
          color: '#a855f7',
          comment: `Mapped in RaccoonIR: ${proc.name}`,
          enabled: true,
          score: 100
        });
      }
    }

    if (techniques.length === 0) {
      this.setStatus('No ATT&CK techniques mapped in this project.');
      return;
    }

    const layer = {
      name: this.project.name + ' — ATT&CK Layer',
      versions: {
        attack: '14',
        navigator: '4.9.1',
        layer: '4.5'
      },
      domain: 'enterprise-attack',
      description: `ATT&CK Navigator layer exported from RaccoonIR project: ${this.project.name}`,
      filters: {
        platforms: ['Linux', 'macOS', 'Windows', 'Network', 'PRE', 'Containers', 'Office 365', 'SaaS', 'IaaS', 'Google Workspace', 'Azure AD']
      },
      sorting: 0,
      layout: { layout: 'side', aggregateFunction: 'average', showID: true, showName: true, showAggregateScores: false, countUnscored: false },
      hideDisabled: false,
      techniques,
      gradient: {
        colors: ['#1a1025', '#a855f7'],
        minValue: 0,
        maxValue: 100
      },
      legendItems: [
        { label: 'Mapped in RaccoonIR', color: '#a855f7' }
      ],
      metadata: [],
      links: [],
      showTacticRowBackground: true,
      tacticRowBackground: '#1a1025',
      selectTechniquesAcrossTactics: true,
      selectSubtechniquesWithParent: false,
      selectVisibleTechniques: false
    };

    const blob = new Blob([JSON.stringify(layer, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (this.project.name || 'raccoon-ir').replace(/[^a-z0-9_-]/gi, '_') + '_navigator_layer.json';
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus(`Exported Navigator layer with ${techniques.length} techniques. Open ATT&CK Navigator → "Open Existing Layer" → upload the file.`);
  }

  /* ---- Impact View ---- */

  _buildImpactToolbar(tb) {
    const iv = this.impactView;

    // Playbook selector
    const pbLbl = document.createElement('span');
    pbLbl.className = 'zoom-info';
    pbLbl.style.marginLeft = '0';
    pbLbl.textContent = 'Playbook:';
    tb.appendChild(pbLbl);

    const pbSel = document.createElement('select');
    pbSel.className = 'tool-select';
    const pbNone = document.createElement('option');
    pbNone.value = ''; pbNone.textContent = '— select —';
    pbSel.appendChild(pbNone);
    for (const proc of Registry.rootProcesses(this.project)) {
      const opt = document.createElement('option');
      opt.value = proc.id; opt.textContent = proc.name;
      if (iv && iv.selectedRootProcessId === proc.id) opt.selected = true;
      pbSel.appendChild(opt);
    }
    pbSel.addEventListener('change', () => {
      if (!iv) return;
      iv.selectedRootProcessId = pbSel.value || null;
      iv._collapsed = new Set();
      iv.activeActivityId = null; iv.activeParagonId = null;
      iv.render();
    });
    tb.appendChild(pbSel);

    this._addToolSep(tb);

    // DM selector
    const dmLbl = document.createElement('span');
    dmLbl.className = 'zoom-info';
    dmLbl.style.marginLeft = '0';
    dmLbl.textContent = 'DM:';
    tb.appendChild(dmLbl);

    const dmSel = document.createElement('select');
    dmSel.className = 'tool-select';
    const dmNone = document.createElement('option');
    dmNone.value = ''; dmNone.textContent = '— select —';
    dmSel.appendChild(dmNone);
    for (const dm of Object.values(this.project.model.dependencyModels)) {
      const opt = document.createElement('option');
      opt.value = dm.id; opt.textContent = dm.name;
      if (iv && iv.selectedDMId === dm.id) opt.selected = true;
      dmSel.appendChild(opt);
    }
    dmSel.addEventListener('change', () => {
      if (!iv) return;
      iv.selectedDMId   = dmSel.value || null;
      iv.activeActivityId = null; iv.activeParagonId = null;
      iv._dmZoom      = null;
      iv._dmPanX      = 0;
      iv._dmPanY      = 0;
      iv._dmCollapsed = new Set();
      iv.render();
    });
    tb.appendChild(dmSel);

    this._addToolSep(tb);

    // Connect mode toggle
    const connBtn = this._addToolBtn(tb, '⛓ Connect', 'Drag from an activity to a paragon to create an ActivityImpact link', () => {
      if (!iv) return;
      iv.connectMode = !iv.connectMode;
      connBtn.classList.toggle('active', iv.connectMode);
      iv.render();
    });
    if (iv && iv.connectMode) connBtn.classList.add('active');

    this._addToolSep(tb);

    // Execute mode toggle
    const execBtn = this._addToolBtn(tb, '⚡ Execute', 'Execute mode: click activities to mark them as executed and accumulate their DM impacts', () => {
      if (!iv) return;
      if (iv.connectMode) { iv.connectMode = false; connBtn.classList.remove('active'); }
      iv.setSimMode('execute');
    });
    if (iv && iv._simMode === 'execute') execBtn.classList.add('active');

    // Step-by-step mode toggle
    const stepBtn = this._addToolBtn(tb, '⏯ Step', 'Step mode: walk through all activities one by one, accumulating DM impacts at each step', () => {
      if (!iv) return;
      iv.setSimMode('step');
    });
    if (iv && iv._simMode === 'step') stepBtn.classList.add('active');

    // Reset simulation
    this._addToolBtn(tb, '⟳ Reset', 'Clear all simulation state', () => {
      if (!iv) return;
      iv.resetSim();
    });

    // Step controls — only shown in step mode
    if (iv && iv._simMode === 'step') {
      this._addToolSep(tb);

      const prevBtn = this._addToolBtn(tb, '◀ Prev', 'Previous activity step', () => {
        if (!iv) return;
        iv.stepPrev();
        this._renderViewToolbar();
      });
      prevBtn.disabled = iv._stepIndex <= -1;

      const counter = document.createElement('span');
      counter.className = 'zoom-info';
      const total = iv._stepQueue.length;
      const cur   = iv._stepIndex + 1;
      counter.textContent = `Step ${cur} / ${total}`;
      counter.style.cssText = 'margin:0 4px;font-weight:bold;min-width:70px;text-align:center;';
      tb.appendChild(counter);

      const nextBtn = this._addToolBtn(tb, 'Next ▶', 'Next activity step', () => {
        if (!iv) return;
        iv.stepNext();
        this._renderViewToolbar();
      });
      nextBtn.disabled = iv._stepIndex >= iv._stepQueue.length - 1;
    }

    this._addToolSep(tb);

    // Snapshot
    this._addToolBtn(tb, '\uD83D\uDCF8 Snapshot', 'Save current execution state as a snapshot', () => this._saveSnapshot());

    this._addToolSep(tb);
    this._addToolBtn(tb, 'Auto Layout', 'Auto-arrange the DM diagram (same algorithm as the DM editor)', () => this._ivAutoLayout());
    this._addToolBtn(tb, '⊡ Fit DM', 'Reset DM pane to auto-fit zoom/pan', () => iv && iv._resetDMView());
    this._addToolBtn(tb, 'Refresh', 'Re-render view', () => iv && iv.render());

    // Hint — adapts to mode
    const hint = document.createElement('span');
    hint.className = 'zoom-info';
    hint.style.cssText = 'margin-left:auto;font-size:10px;white-space:nowrap;color:#5a6880;';
    if (iv && iv._simMode === 'execute') {
      hint.textContent = 'Click activity to execute/un-execute it  |  Right-click arrow to edit/delete';
    } else if (iv && iv._simMode === 'step') {
      hint.textContent = 'Click activity to jump to that step  |  Use Prev/Next or click steps';
    } else {
      hint.textContent = 'Click activity to preview impact  |  Right-click arrow to edit/delete';
    }
    tb.appendChild(hint);
  }

  _renderImpactView() {
    if (!this.impactView) return;
    const iv = this.impactView;
    // Auto-select first items if nothing chosen yet
    if (!iv.selectedRootProcessId) {
      const first = Registry.rootProcesses(this.project)[0];
      if (first) iv.selectedRootProcessId = first.id;
    }
    if (!iv.selectedDMId) {
      const first = Object.values(this.project.model.dependencyModels)[0];
      if (first) iv.selectedDMId = first.id;
    }
    iv.render();
  }

  /** Capture current model state: all paragon leafProbabilities + all activity statuses. */
  _captureCurrentState() {
    const paragonProbabilities = {};
    for (const dm of Object.values(this.project.model.dependencyModels)) {
      for (const [id, p] of Object.entries(dm.paragons)) {
        paragonProbabilities[id] = p.leafProbability;
      }
    }
    const activityStatuses = {};
    for (const [id, proc] of Object.entries(this.project.model.processes)) {
      activityStatuses[id] = proc.status;
    }
    return { paragonProbabilities, activityStatuses };
  }

  _saveSnapshot() {
    const iv = this.impactView;

    // Capture full current state
    const state = this._captureCurrentState();

    // If a simulation is active, merge sim overrides on top
    if (iv && iv._simMode) {
      for (const [parId, val] of Object.entries(iv._simOverrides || {})) {
        state.paragonProbabilities[parId] = val;
      }
      // Mark executed/stepped activities as COMPLETED
      let completedIds = [];
      if (iv._simMode === 'execute') {
        completedIds = [...iv._executedIds];
      } else if (iv._simMode === 'step' && iv._stepIndex >= 0) {
        completedIds = iv._stepQueue.slice(0, iv._stepIndex + 1);
      }
      for (const pid of completedIds) {
        state.activityStatuses[pid] = STATUS_ENUM.COMPLETED;
      }
    }

    const defaultLabel = new Date().toLocaleString();
    this.showInputModal('Save Snapshot', 'Snapshot label:', defaultLabel, label => {
      if (!label.trim()) return;
      if (!Array.isArray(this.project.snapshots)) this.project.snapshots = [];
      this.project.snapshots.push(createSnapshot(label.trim(),
        state.paragonProbabilities, state.activityStatuses));
      this._renderExplorer();
      this._markDirty();
      this.setStatus(`Snapshot "${label.trim()}" saved.`);
    });
  }

  /** Apply a snapshot: write its stored values back into the live model. */
  _applySnapshot(snap) {
    const pp = snap.paragonProbabilities;
    const as = snap.activityStatuses;
    if (!pp && !as) {
      this.setStatus('Cannot apply: snapshot is in an older format.');
      return;
    }
    // Auto-capture baseline before first-ever application
    if (!this.project.baseline) {
      this.project.baseline = this._captureCurrentState();
    }
    this._pushUndo();
    if (pp) {
      for (const dm of Object.values(this.project.model.dependencyModels)) {
        for (const [id, p] of Object.entries(dm.paragons)) {
          if (pp[id] !== undefined) p.leafProbability = pp[id];
        }
      }
    }
    if (as) {
      for (const [id, proc] of Object.entries(this.project.model.processes)) {
        if (as[id] !== undefined) proc.status = as[id];
      }
    }
    this.dmEditor && this.dmEditor.render();
    this.pbEditor && this.pbEditor.render();
    this._syncImpactView();
    this._renderExplorer();   // refresh in case baseline section appears
    if (this.activeTab === 'metrics') this._renderMetrics();
    this._markDirty();
    this.setStatus(`Snapshot "${snap.label}" applied.`);
  }

  /** Reset all paragon probabilities and activity statuses to the baseline. */
  _resetToBaseline() {
    if (!this.project.baseline) {
      this.setStatus('No baseline recorded. Apply a snapshot first to establish the original state.');
      return;
    }
    this._pushUndo();
    const { paragonProbabilities: pp, activityStatuses: as } = this.project.baseline;
    if (pp) {
      for (const dm of Object.values(this.project.model.dependencyModels)) {
        for (const [id, p] of Object.entries(dm.paragons)) {
          if (pp[id] !== undefined) p.leafProbability = pp[id];
        }
      }
    }
    if (as) {
      for (const [id, proc] of Object.entries(this.project.model.processes)) {
        if (as[id] !== undefined) proc.status = as[id];
      }
    }
    this.dmEditor && this.dmEditor.render();
    this.pbEditor && this.pbEditor.render();
    this._syncImpactView();
    if (this.activeTab === 'metrics') this._renderMetrics();
    this._markDirty();
    this.setStatus('Reset to original state.');
  }

  _renderSnapshotProperties(snap) {
    const el = this.els['properties-content'];
    el.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'prop-section-title';
    title.textContent = '\uD83D\uDCF8 Snapshot';
    el.appendChild(title);

    // Label (editable)
    el.appendChild(this._propRow('Label', this._textInput('snap-label', snap.label, v => {
      snap.label = v; this._renderExplorer(); this._markDirty();
    })));
    el.appendChild(this._propRow('Created', this._staticText(snap.createdAt)));

    const pp = snap.paragonProbabilities || {};
    const as = snap.activityStatuses     || {};
    const paragonsCount   = Object.keys(pp).length;
    const activitiesCount = Object.keys(as).length;
    el.appendChild(this._propRow('Paragons',   this._staticText(String(paragonsCount))));
    el.appendChild(this._propRow('Activities', this._staticText(String(activitiesCount))));

    // Apply button
    const applyBtn = document.createElement('button');
    applyBtn.className = 'tool-btn';
    applyBtn.style.cssText = 'margin-top:10px;width:100%;';
    applyBtn.textContent = '\u25B6 Apply Snapshot';
    applyBtn.title = 'Load this snapshot into the model (sets paragon probabilities and activity statuses)';
    applyBtn.addEventListener('click', () => this._applySnapshot(snap));
    el.appendChild(applyBtn);

    // Activities with COMPLETED status
    const completedEntries = Object.entries(as).filter(([, s]) => s === STATUS_ENUM.COMPLETED);
    if (completedEntries.length > 0) {
      const actTitle = document.createElement('div');
      actTitle.className = 'prop-section-title';
      actTitle.textContent = 'Completed Activities';
      el.appendChild(actTitle);
      for (const [pid] of completedEntries) {
        const p = this.project.model.processes[pid];
        el.appendChild(this._propRow(null, this._staticText((p ? p.name : pid) + ' \u2713', 'text-success')));
      }
    }

    // Paragon probabilities — show ones that differ from current model
    if (paragonsCount > 0) {
      const parTitle = document.createElement('div');
      parTitle.className = 'prop-section-title';
      parTitle.textContent = 'Paragon Probabilities';
      el.appendChild(parTitle);
      for (const [parId, snapVal] of Object.entries(pp)) {
        const par  = Registry.getParagon(this.project, parId);
        const curr = par ? par.leafProbability : null;
        const label = par ? par.description : parId;
        const diff  = curr !== null && Math.abs(curr - snapVal) > 0.0001;
        const txt   = diff
          ? `${Metrics.formatProb(snapVal)} (current: ${Metrics.formatProb(curr)})`
          : Metrics.formatProb(snapVal);
        el.appendChild(this._propRow(label, this._staticText(txt,
          diff ? (snapVal > curr ? 'text-success' : 'text-danger') : 'text-muted')));
      }
    }

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'tool-btn';
    delBtn.style.cssText = 'margin-top:12px;width:100%;color:#e74c3c;border-color:#e74c3c;';
    delBtn.textContent = '\uD83D\uDDD1 Delete Snapshot';
    delBtn.addEventListener('click', () => {
      this.project.snapshots = this.project.snapshots.filter(s => s.id !== snap.id);
      this._renderExplorer();
      this._showNoSelection();
      this._markDirty();
      this.setStatus('Snapshot deleted.');
    });
    el.appendChild(delBtn);
  }

  showImpactContextMenu(e, procId, paragonId, view) {
    const proc    = this.project.model.processes[procId];
    const dm      = Registry.findDMForParagon(this.project, paragonId);
    const par     = dm && dm.paragons[paragonId];
    const impact  = proc && proc.activityImpacts.find(i => i.paragonId === paragonId);

    const items = [
      { label: `${proc ? proc.name.substring(0,18) : '?'} → ${par ? par.description.substring(0,18) : '?'}`, fn: () => {} },
      { sep: true },
      { label: '✏ Edit Value', fn: () => {
        if (!impact) return;
        this.showInputModal('Edit Impact Probability', 'New value (0–1):', String(impact.newValue), val => {
          const nv = Math.min(1, Math.max(0, parseFloat(val) || 0));
          impact.newValue = nv;
          this._markDirty();
          if (view) view.render();
        });
      }},
      { sep: true },
      { label: '🗑 Delete Connection', danger: true, fn: () => {
        if (!confirm('Delete this activity impact?')) return;
        this._pushUndo();
        proc.activityImpacts = proc.activityImpacts.filter(i => i.paragonId !== paragonId);
        this._markDirty();
        if (view) view.render();
      }}
    ];
    this._showContextMenu(e, items);
  }

  /* ---- File Operations ---- */

  _newProject() {
    if (this.isDirty && !confirm('Discard unsaved changes?')) return;
    localStorage.removeItem('raccoon-ir-autosave');
    this.project = createProject('New Project');
    this._currentFilename = null;
    this._loadProject();
    this._updateFilenameDisplay();
    this.setStatus('New project created.');
  }

  async _onFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text = await Storage.readFile(file);
      const ext = file.name.split('.').pop().toLowerCase();

      if (ext === 'dependencymodel') {
        // Import as a dependency model
        const dm = Storage.importDependencyModelXML(text);
        this._pushUndo();
        this.project.model.dependencyModels[dm.id] = dm;
        this.project.representation.dmViews[dm.id] = createDMView();
        this._renderExplorer();
        this._selectDM(dm.id);
        this._switchTab('dm');
        this._markDirty();
        this.setStatus(`Imported dependency model: ${dm.name}`);
      } else if (ext === 'raccoon') {
        // Import as a playbook
        const result = Storage.importRaccoonXML(text);
        this._pushUndo();
        Object.assign(this.project.model.processes, result.processes);
        Object.assign(this.project.model.actuators, result.actuators);
        // Add to first org, or create one
        let org = Object.values(this.project.model.organisations)[0];
        if (!org) {
          org = createOrganisation('Imported Organisation');
          this.project.model.organisations[org.id] = org;
        }
        org.rootProcessIds.push(result.rootProcessId);
        this.project.representation.pbViews[result.rootProcessId] = createPBView();
        this._renderExplorer();
        this._selectRootProcess(result.rootProcessId);
        this._switchTab('pb');
        this._markDirty();
        this.setStatus(`Imported playbook`);
      } else {
        // Try as full project JSON
        const proj = Storage.deserialize(text);
        if (this.isDirty && !confirm('Discard unsaved changes and open this file?')) return;
        this.project = proj;
        this._currentFilename = file.name.replace(/\.raccoon-ir\.json$/i, '').replace(/\.json$/i, '');
        this._loadProject();
        this._updateFilenameDisplay();
        this._scheduleAutoSave();
        this.setStatus(`Opened: ${proj.name}`);
      }
    } catch (err) {
      alert('Error opening file: ' + err.message);
      console.error(err);
    }
  }

  _loadProject(preserveTab = false) {
    // Reset impact simulation state
    this._impactSimActive = false;

    if (this.dmEditor) this.dmEditor.setDM(null, {});
    if (this.pbEditor) {
      this.pbEditor.setProject(this.project);
      this.pbEditor.currentProcessId = null;
      this.pbEditor.navStack = [];
    }
    if (this.impactView) {
      this.impactView.selectedRootProcessId = null;
      this.impactView.selectedDMId          = null;
      this.impactView.activeActivityId      = null;
      this.impactView.activeParagonId       = null;
      this.impactView.connectMode           = false;
      this.impactView._simMode              = null;
      this.impactView._executedIds          = new Set();
      this.impactView._stepQueue            = [];
      this.impactView._stepIndex            = -1;
      this.impactView._simOverrides         = {};
      this.impactView._collapsed            = new Set();
      this.impactView._dmCollapsed          = new Set();
      this.impactView._dmZoom               = null;
      this.impactView._dmPanX               = 0;
      this.impactView._dmPanY               = 0;
    }

    // Clear metrics and symbiosis content areas so stale content is never shown
    if (this.els['metrics-content'])  this.els['metrics-content'].innerHTML  = '';
    if (this.els['symbiosis-content']) this.els['symbiosis-content'].innerHTML = '';

    this.isDirty = false;
    this._renderExplorer();
    this._showNoSelection();

    if (preserveTab) {
      // Undo/redo: keep current tab, just refresh its content
      const firstDM = Object.values(this.project.model.dependencyModels)[0];
      if (firstDM) this._selectDM(firstDM.id);
      const firstProc = Registry.rootProcesses(this.project)[0];
      if (firstProc && !firstDM) this._selectRootProcess(firstProc.id);
      // Refresh whatever tab is currently active
      if (this.activeTab === 'metrics')  this._renderMetrics();
      else if (this.activeTab === 'symbiosis') this._renderSymbiosis();
      else if (this.activeTab === 'impact') this._renderImpactView();
      else this._renderViewToolbar();
      return;
    }

    // New file / open file: reset undo/redo stacks and navigate to first content
    this.undoStack = []; this.redoStack = [];
    this.els['btn-undo'].disabled = true;
    this.els['btn-redo'].disabled = true;

    const firstDM = Object.values(this.project.model.dependencyModels)[0];
    if (firstDM) {
      this._switchTab('dm');
      this._selectDM(firstDM.id);
      return;
    }
    const firstProc = Registry.rootProcesses(this.project)[0];
    if (firstProc) {
      this._switchTab('pb');
      this._selectRootProcess(firstProc.id);
      return;
    }
    // Empty project
    this._switchTab('dm');
  }

  _saveProject() {
    const json = Storage.serialize(this.project);
    const base = this._currentFilename || (this.project.name || 'raccoon-project').replace(/\s+/g, '-').toLowerCase();
    Storage.downloadJSON(json, base + '.raccoon-ir.json');
    this._currentFilename = base;
    this._updateFilenameDisplay();
    this.isDirty = false;
    this.setStatus(`Saved: ${this.project.name}`);
  }

  _importFile() {
    // Open file dialog for model-only import
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.dependencymodel,.raccoon';
    input.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await Storage.readFile(file);
      try {
        Storage.importModelOnly(text, this.project);
        this._renderExplorer();
        this._markDirty();
        this.setStatus('Model imported.');
      } catch (err) {
        alert('Error importing: ' + err.message);
      }
    });
    input.click();
  }

  _updateFilenameDisplay() {
    const el = document.getElementById('current-filename');
    if (!el) return;
    el.textContent = this._currentFilename || '';
    el.style.display = this._currentFilename ? '' : 'none';
  }

  _exportModelOnly() {
    const json = Storage.exportModelOnly(this.project);
    const name = (this.project.name || 'raccoon-model').replace(/\s+/g,'-').toLowerCase();
    Storage.downloadJSON(json, name + '.model.json');
    this.setStatus('Exported model (without representation data).');
  }

  /* ---- Example Library ---- */

  /**
   * Build an ActivityImpact override map for CiO computation.
   * @param {string|null} scopeId - null = all activities; string = root process ID only
   * @returns {{ [paragonId]: number }}
   */
  _buildImpactOverrides(scopeId) {
    const overrides = {};
    const collect = id => {
      const proc = this.project.model.processes[id];
      if (!proc) return;
      for (const imp of (proc.activityImpacts || []))
        if (imp.paragonId) overrides[imp.paragonId] = imp.newValue;
      for (const sub of (proc.subProcessIds || [])) collect(sub);
    };
    if (scopeId) {
      collect(scopeId);
    } else {
      for (const proc of Registry.rootProcesses(this.project)) collect(proc.id);
    }
    return overrides;
  }

  async _openLibrary() {
    this.setStatus('Loading example library...');
    let manifest;
    try {
      const resp = await fetch('examples/manifest.json');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      manifest = await resp.json();
    } catch (e) {
      alert(
        'Could not load the example library.\n\n' +
        'The app must be served from a web server (not opened as a local file:// URL).\n\n' +
        'Detail: ' + e.message
      );
      this.setStatus('Library unavailable.');
      return;
    }

    let html = '<p style="font-size:12px;color:#8899b0;margin-bottom:10px">Click an example to open it. Unsaved changes will be lost.</p>';
    html += '<div id="library-list" style="display:flex;flex-direction:column;gap:6px;">';
    for (const item of manifest) {
      html += `<div class="library-item" data-file="${this._esc(item.filename)}"
        style="cursor:pointer;padding:9px 12px;border-radius:4px;background:#1a2035;border:1px solid var(--border);transition:border-color .15s">
        <div style="font-weight:600;font-size:13px;color:#e0e8ff;margin-bottom:2px">${this._esc(item.name)}</div>
        <div style="font-size:11px;color:#8899b0;">${this._esc(item.description)}</div>
        <div style="font-size:10px;color:#a855f7;margin-top:3px">${this._esc(item.filename)}</div>
      </div>`;
    }
    html += '</div>';

    this.els['modal-header'].textContent = 'Example Library';
    this.els['modal-body'].innerHTML = html;
    this.els['modal-ok'].style.display = 'none';
    this.els['modal-cancel'].textContent = 'Close';
    this.els['modal-overlay'].classList.remove('hidden');
    this._modalOKHandler = null;

    // Hover styles and click handlers
    this.els['modal-body'].querySelectorAll('.library-item').forEach(item => {
      item.addEventListener('mouseenter', () => { item.style.borderColor = '#a855f7'; });
      item.addEventListener('mouseleave', () => { item.style.borderColor = 'var(--border)'; });
      item.addEventListener('click', () => {
        this._restoreModalDefaults();
        this._closeModal();
        this._loadExampleFile(item.dataset.file);
      });
    });

    this.els['modal-cancel'].onclick = () => {
      this._restoreModalDefaults();
      this._closeModal();
    };
  }

  _restoreModalDefaults() {
    this.els['modal-ok'].style.display = '';
    this.els['modal-cancel'].textContent = 'Cancel';
  }

  async _loadExampleFile(filename) {
    this.setStatus(`Loading ${filename}...`);
    try {
      const resp = await fetch(`examples/${filename}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      this.project = Storage.deserialize(text);
      this._currentFilename = filename.replace(/\.raccoon-ir\.json$/i, '').replace(/\.json$/i, '');
      this._updateFilenameDisplay();
      this._loadProject();
      this.setStatus(`Loaded: ${this.project.name}`);
    } catch (e) {
      alert('Could not load example file: ' + e.message);
    }
  }

  /* ---- Undo / Redo ---- */

  _pushUndo() {
    this.undoStack.push(Storage.serialize(this.project));
    if (this.undoStack.length > 10) this.undoStack.shift();
    this.redoStack = [];
    this.els['btn-undo'].disabled = false;
    this.els['btn-redo'].disabled = true;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(Storage.serialize(this.project));
    const prev = this.undoStack.pop();
    this.project = Storage.deserialize(prev);
    this._loadProject(true);
    this.els['btn-undo'].disabled = !this.undoStack.length;
    this.els['btn-redo'].disabled = false;
    this.setStatus('Undone.');
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(Storage.serialize(this.project));
    const next = this.redoStack.pop();
    this.project = Storage.deserialize(next);
    this._loadProject(true);
    this.els['btn-undo'].disabled = false;
    this.els['btn-redo'].disabled = !this.redoStack.length;
    this.setStatus('Redone.');
  }

  /* ---- Modal ---- */

  showModal(title, bodyHTML, onOK) {
    this.els['modal-header'].textContent = title;
    this.els['modal-body'].innerHTML = bodyHTML;
    this.els['modal-overlay'].classList.remove('hidden');
    this._modalOKHandler = onOK;

    this.els['modal-ok'].onclick = () => {
      this._closeModal();
      if (this._modalOKHandler) this._modalOKHandler();
    };
    this.els['modal-cancel'].onclick = () => this._closeModal();

    // Focus first input
    const firstInput = this.els['modal-body'].querySelector('input,textarea,select');
    if (firstInput) { firstInput.focus(); firstInput.select(); }
  }

  showInputModal(title, label, defaultVal, onOK) {
    this.showModal(title,
      `<div class="prop-row"><label class="prop-label">${label}</label>
       <input id="modal-input" type="text" value="${this._esc(defaultVal)}" style="width:100%"></div>`,
      () => {
        const val = document.getElementById('modal-input').value;
        onOK(val);
      }
    );
    // Allow Enter to submit
    setTimeout(() => {
      const inp = document.getElementById('modal-input');
      if (inp) {
        inp.addEventListener('keydown', e => {
          if (e.key === 'Enter') { this.els['modal-ok'].click(); }
        });
      }
    }, 0);
  }

  _closeModal() {
    this.els['modal-overlay'].classList.add('hidden');
  }

  /* ---- Helpers for property forms ---- */

  _propGroup(title, rows) {
    const div = document.createElement('div');
    div.className = 'prop-group';
    const t = document.createElement('div');
    t.className = 'prop-group-title';
    t.textContent = title;
    div.appendChild(t);
    for (const row of rows) if (row) div.appendChild(row);
    return div;
  }

  _propRow(label, valueEl) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    if (label) {
      const lbl = document.createElement('label');
      lbl.className = 'prop-label';
      lbl.textContent = label;
      row.appendChild(lbl);
    }
    if (valueEl) row.appendChild(valueEl);
    return row;
  }

  _textInput(id, value, onChange) {
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = value || '';
    inp.addEventListener('input', () => onChange(inp.value));
    return inp;
  }

  _textareaInput(id, value, onChange) {
    const ta = document.createElement('textarea');
    ta.value = value || '';
    ta.addEventListener('input', () => onChange(ta.value));
    return ta;
  }

  _rangeInput(id, value, min, max, step, onChange) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';

    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
    inp.style.cssText = 'flex:1;min-width:60px;';

    const num = document.createElement('input');
    num.type = 'number'; num.min = min; num.max = max; num.step = step;
    num.value = parseFloat(value).toFixed(2);
    num.style.cssText = 'width:54px;text-align:right;font-size:11px;padding:2px 4px;flex-shrink:0;';
    num.title = 'Type an exact value (0.00 – 1.00) and press Enter';

    // Slider → number field (live while dragging)
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      num.value = v.toFixed(2);
      onChange(inp.value);
    });

    // Number field → slider (on commit: Enter or blur)
    const commitNum = () => {
      const v = Math.min(max, Math.max(min, parseFloat(num.value) || 0));
      num.value = v.toFixed(2);
      inp.value = v;
      onChange(String(v));
    };
    num.addEventListener('change', commitNum);
    num.addEventListener('keydown', e => { if (e.key === 'Enter') { commitNum(); e.target.blur(); } });

    wrap.appendChild(inp);
    wrap.appendChild(num);
    return wrap;
  }

  _selectInput(id, enumObj, value, onChange) {
    const sel = document.createElement('select');
    for (const v of Object.values(enumObj)) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      if (v === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  _dateInput(id, value, onChange) {
    const inp = document.createElement('input');
    inp.type = 'date';
    if (value) inp.value = value.substring ? value.substring(0, 10) : '';
    inp.addEventListener('change', () => onChange(inp.value));
    return inp;
  }

  _checkInput(id, value, onChange) {
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.checked = !!value;
    inp.addEventListener('change', () => onChange(inp.checked));
    lbl.appendChild(inp);
    lbl.appendChild(document.createTextNode('Yes'));
    return lbl;
  }

  _staticText(text, cssClass) {
    const span = document.createElement('span');
    span.style.cssText = 'font-size:12px;';
    if (cssClass) span.className = cssClass;
    span.textContent = text;
    return span;
  }

  _paragonSelect(currentParagonId, onChange) {
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = ''; none.textContent = '— None —';
    sel.appendChild(none);
    for (const dm of Object.values(this.project.model.dependencyModels)) {
      const visitParagon = (id) => {
        const p = dm.paragons[id];
        if (!p) return;
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `[${dm.name}] ${p.description}`;
        if (p.id === currentParagonId) opt.selected = true;
        sel.appendChild(opt);
        for (const cid of p.childIds) visitParagon(cid);
      };
      if (dm.rootId) visitParagon(dm.rootId);
    }
    sel.addEventListener('change', () => onChange(sel.value || null));
    return sel;
  }

  _showNoSelection() {
    const el = this.els['properties-content'];
    el.innerHTML = '<p class="no-selection">Select an element to view its properties.</p>';
  }

  _getRootProcessId(processId) {
    // Walk up to find the root process for an org
    let id = processId;
    for (let i = 0; i < 50; i++) {
      const parent = Registry.parentProcess(this.project, id);
      if (!parent) break;
      id = parent.id;
    }
    return id;
  }

  /* ---- Status and Zoom ---- */

  setStatus(msg) {
    if (this.els['status-message']) this.els['status-message'].textContent = msg;
  }

  updateZoom(zoom) {
    const zd = document.getElementById('zoom-display');
    if (zd) zd.textContent = Math.round(zoom * 100) + '%';
  }

  updateCoords(x, y) {
    if (this.els['status-coords']) this.els['status-coords'].textContent = `${x}, ${y}`;
  }

  _markDirty() {
    this.isDirty = true;
    this._scheduleAutoSave();
  }

  _scheduleAutoSave() {
    clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(() => {
      try {
        localStorage.setItem('raccoon-ir-autosave', Storage.serialize(this.project));
      } catch (e) {
        console.warn('Autosave failed:', e);
      }
    }, 1500);
  }

  _syncImpactView() {
    if (this.activeTab === 'impact' && this.impactView) this.impactView.render();
  }

  /* ---- Escape HTML ---- */

  _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }
}

/* ---- Bootstrap ---- */
window.addEventListener('DOMContentLoaded', () => {
  window.app = new RaccoonIRApp();
  window.app.init();
});
