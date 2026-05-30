'use strict';
/* ============================================================
 * RaccoonIR Help System
 * Renders a full-screen help panel with two sections:
 *   - Tutorial: step-by-step guide to using RaccoonIR
 *   - Metamodels: formal class diagrams derived from metamodel-data.js
 * ============================================================ */

const HelpPanel = {
  _overlay: null,
  _activeTab: 'tutorial',

  /* ---- Public API ---- */

  open(tab) {
    this._activeTab = tab || 'tutorial';
    if (!this._overlay) this._build();
    this._overlay.classList.remove('hidden');
    this._showTab(this._activeTab);
  },

  close() {
    if (this._overlay) this._overlay.classList.add('hidden');
  },

  /* ---- Build panel DOM (once) ---- */

  _build() {
    const ov = document.createElement('div');
    ov.id = 'help-overlay';
    ov.className = 'help-overlay hidden';

    ov.innerHTML = `
      <div class="help-panel">
        <div class="help-header">
          <span class="help-title">RaccoonIR Help</span>
          <div class="help-tabs">
            <button class="help-tab active" data-tab="tutorial">Tutorial</button>
            <button class="help-tab" data-tab="metamodel">Metamodels</button>
            <button class="help-tab" data-tab="about">About</button>
          </div>
          <button class="help-close" id="help-close-btn" title="Close Help">&times;</button>
        </div>
        <div class="help-body">
          <div id="help-tutorial"  class="help-section"></div>
          <div id="help-metamodel" class="help-section hidden"></div>
          <div id="help-about"     class="help-section hidden"></div>
        </div>
      </div>`;

    document.body.appendChild(ov);
    this._overlay = ov;

    ov.querySelector('#help-close-btn').addEventListener('click', () => this.close());
    ov.querySelectorAll('.help-tab').forEach(btn => {
      btn.addEventListener('click', () => this._showTab(btn.dataset.tab));
    });
    // Click outside panel to close
    ov.addEventListener('click', e => {
      if (e.target === ov) this.close();
    });

    this._renderTutorial(ov.querySelector('#help-tutorial'));
    this._renderMetamodels(ov.querySelector('#help-metamodel'));
    this._renderAbout(ov.querySelector('#help-about'));
  },

  _showTab(tab) {
    this._activeTab = tab;
    this._overlay.querySelectorAll('.help-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    this._overlay.querySelectorAll('.help-section').forEach(s => {
      s.classList.toggle('hidden', s.id !== 'help-' + tab);
    });
  },

  /* ================================================================
   * TUTORIAL
   * ================================================================ */

  _renderTutorial(container) {
    container.innerHTML = this._tutorialHTML();
  },

  _tutorialHTML() {
    return `
<div class="tut-wrap">

<!-- ==================== TOC ==================== -->
<div class="tut-toc">
  <div class="tut-toc-title">Contents</div>
  <a href="#tut-intro">1. Introduction</a>
  <a href="#tut-concepts">2. Key Concepts</a>
  <a href="#tut-quickstart">3. Quick Start</a>
  <a href="#tut-ui">4. User Interface</a>
  <a href="#tut-dm">5. Dependency Model</a>
  <a href="#tut-playbook">6. Playbook</a>
  <a href="#tut-impact">7. Connecting Models</a>
  <a href="#tut-impactview">8. Impact View</a>
  <a href="#tut-metrics">9. Metrics</a>
  <a href="#tut-ct">10. Critical Threshold</a>
  <a href="#tut-snapshots">11. Snapshots</a>
  <a href="#tut-symbiosis">12. SYMBIOSIS</a>
  <a href="#tut-files">13. Files &amp; Import/Export</a>
  <a href="#tut-examples">14. Example Projects</a>
</div>

<!-- ==================== CONTENT ==================== -->
<div class="tut-content">

<!-- 1 -->
<h2 id="tut-intro">1. Introduction</h2>
<p>
  <strong>RaccoonIR</strong> is a browser-based modelling tool for
  <em>Operations-Informed Incident Response Playbook Planning</em>.
   It implements the RaccoonIR metamodel (based on FRIPP, Shaked et al. 2023) which combines:
</p>
<ul>
  <li><strong>PROVE</strong> — artifact-centric process modelling for incident response playbooks</li>
  <li><strong>Dependency Models (DM)</strong> — hierarchical system goal / component trees with probability-based operational assessment</li>
  <li><strong>CiO (Change in Operations)</strong> — a metric measuring how each system component contributes to the overall operational goal</li>
  <li><strong>ActivityImpact</strong> — the cross-model link showing how executing a playbook activity changes system probabilities</li>
</ul>
<div class="tut-note">
   All models created in RaccoonIR strictly conform to the RaccoonIR metamodel.
  The formal metamodel definition is available under the <b>Metamodels</b> tab above.
</div>

<!-- 2 -->
<h2 id="tut-concepts">2. Key Concepts</h2>

<h3>Paragon</h3>
<p>
  A <em>paragon</em> is a node in a Dependency Model representing a system goal, sub-goal,
  or component. Each paragon has a <strong>computed probability</strong> representing the
  likelihood that the goal is currently satisfied.
</p>
<ul>
  <li><strong>AND node</strong>: P = product of all children's probabilities (all must hold)</li>
  <li><strong>OR node</strong>: P = 1 − ∏(1 − P<sub>child</sub>) (at least one must hold)</li>
  <li><strong>UNCONTROLLABLE leaf</strong>: P is set directly as a fixed value</li>
</ul>
<p>The root paragon represents the <em>overall system operational goal</em>.</p>

<h3>CiO (Change in Operations)</h3>
<p>
  CiO measures the <em>actual change in operational probability</em> caused by a set of response activities.
  For any node <em>x</em> and a set of activities <em>A</em>:
</p>
<div class="tut-formula">
  CiO(x, A) = P<sub>after A</sub>(x) &minus; P<sub>before A</sub>(x)
</div>
<p>
  CiO is positive when the activities improve the operational state, negative when they degrade it, and zero when
  they have no effect on this node. CiO propagates through the dependency tree: if activity <em>a</em> directly
  changes paragon <em>x</em>, its parent <em>y</em> (which depends on <em>x</em>) will also have a non-zero CiO.
</p>
<p><strong>Example:</strong> If activityA sets paragonX from 0.5 → 0.8, then CiO(paragonX, {activityA}) = +0.3.
  If paragonY depends on paragonX and its probability consequently rises from 0.4 → 0.6, then CiO(paragonY, {activityA}) = +0.2.
</p>

<h3>ActivityImpact</h3>
<p>
  An <em>ActivityImpact</em> links a PlaybookProcess to a Paragon and specifies a
  <strong>new probability value</strong> that the paragon will have after the activity executes.
  This allows analysts to answer: "If we execute this activity, how does it change our operational posture?"
</p>

<h3>Critical Threshold (CT)</h3>
<p>
  An optional minimum probability value assigned to a paragon. If the computed probability
  falls below this threshold — either now or as a result of a planned activity —
  assigned stakeholders must be notified (or asked for approval, depending on <em>Notify Mode</em>).
</p>

<h3>PlaybookProcess</h3>
<p>
  A node in an incident response playbook. Playbooks are hierarchical — each process can
  have sub-processes, enabling drill-down from high-level phases to individual actions.
  Processes consume and produce <em>artifact state instances</em> (data flows between activities).
</p>

<h3>Snapshot</h3>
<p>
  A named capture of the full model state at a specific point in time: all paragon probabilities
  and all activity statuses. Snapshots let you record and replay the state of the incident
  at any milestone during response operations.
</p>

<!-- 3 -->
<h2 id="tut-quickstart">3. Quick Start</h2>

<div class="tut-steps">
  <div class="tut-step">
    <div class="tut-step-num">1</div>
    <div class="tut-step-body">
      <strong>Open an example project</strong><br>
       Click <kbd>Open</kbd> in the header toolbar and select any file from the
      <code>examples/</code> folder. Start with <code>examples/phishing-t1566.json</code> —
      a complete Phishing Attack Response scenario with MITRE ATT&CK/D3FEND mappings, Dependency Model, and Playbook already connected.
    </div>
  </div>
  <div class="tut-step">
    <div class="tut-step-num">2</div>
    <div class="tut-step-body">
      <strong>Explore the Dependency Model tab</strong><br>
      Click the <em>Dependency Models</em> tab. You will see a tree of paragons colour-coded
      by probability (green = high, orange = medium, red = low). Click any node to see its
      properties on the right.
    </div>
  </div>
  <div class="tut-step">
    <div class="tut-step-num">3</div>
    <div class="tut-step-body">
      <strong>Explore the Playbooks tab</strong><br>
      Click the <em>Playbooks</em> tab. Click an activity node to see its properties.
      Double-click to navigate into sub-activities.
    </div>
  </div>
  <div class="tut-step">
    <div class="tut-step-num">4</div>
    <div class="tut-step-body">
      <strong>Try the Impact View</strong><br>
      Click the <em>Impact View</em> tab. The playbook is on the left, the dependency model
      on the right. Red arrows show ActivityImpact connections. Click any activity to see
      how its impacts would change the DM probabilities in real time.
    </div>
  </div>
  <div class="tut-step">
    <div class="tut-step-num">5</div>
    <div class="tut-step-body">
      <strong>Review the Metrics tab</strong><br>
      Click <em>Metrics</em> to see a table of all paragons with computed probability,
      CiO value (probability change caused by activities), and Critical Threshold alerts.
      Use the <em>CiO scope</em> dropdown to select which playbook's activities to evaluate.
      Click any row to view that element's properties.
    </div>
  </div>
</div>

<!-- 4 -->
<h2 id="tut-ui">4. User Interface</h2>

<h3>Three-Pane Layout</h3>
<p>The main window is divided into three resizable panels:</p>
<ul>
  <li><strong>Model Explorer</strong> (left) — hierarchical tree of all model elements. Each section and item is collapsible/expandable using the ▶/▼ toggle arrows.</li>
  <li><strong>Canvas Area</strong> (centre) — the active graphical editor or view for the selected tab.</li>
  <li><strong>Properties Panel</strong> (right) — editable properties for the currently selected element.</li>
</ul>
<p>
  Drag the <strong>vertical dividers</strong> between panels to resize them. The layout is
  remembered between sessions (stored in <code>localStorage</code>).
</p>

<h3>Model Explorer — Collapse &amp; Expand</h3>
<p>
  Every level of the Model Explorer tree is independently collapsible:
</p>
<ul>
  <li>Click the <strong>▶/▼ arrow</strong> on a section header (Dependency Models, Organisations &amp; Playbooks, etc.) to show/hide its entire contents.</li>
  <li>Click the <strong>▶/▼ toggle</strong> next to an individual Dependency Model to show/hide its paragon tree.</li>
  <li>Click the <strong>▶/▼ toggle</strong> next to an Organisation to show/hide its roles and playbooks.</li>
  <li>Within an organisation, the <strong>Roles</strong> and <strong>Playbooks</strong> sub-sections also have individual collapse toggles.</li>
</ul>
<p>Collapse state is preserved across re-renders within the session.</p>

<h3>Current Filename</h3>
<p>
  When a project file is opened or saved, its filename (without extension) appears as a
  <strong>📄 label</strong> in the header toolbar, to the right of the Help button.
  This makes it easy to confirm which file is currently loaded.
</p>

<!-- 5 -->
<h2 id="tut-dm">5. Dependency Model</h2>

<h3>Creating a Dependency Model</h3>
<ol>
  <li>Go to the <em>Dependency Models</em> tab.</li>
  <li>Click <kbd>+ DM</kbd> in the view toolbar. Enter a name.</li>
  <li>A root AND-node is created automatically.</li>
  <li>Use the toolbar buttons or right-click menu to add children:
    <ul>
      <li><kbd>+ AND</kbd> — all sub-goals must hold</li>
      <li><kbd>+ OR</kbd> — any sub-goal is sufficient</li>
      <li><kbd>+ Leaf</kbd> — UNCONTROLLABLE leaf with a fixed probability</li>
    </ul>
  </li>
</ol>

<h3>Setting Probabilities</h3>
<p>
  Select a leaf node (UNCONTROLLABLE). In the Properties panel, use the <em>Leaf Probability</em>
  slider to set its value. Non-leaf probabilities are computed automatically from children.
</p>

<h3>Node Colours</h3>
<div class="tut-colour-key">
  <div class="tut-ckey-row"><span class="tut-dot green"></span> Green (≥ 70%) — high operational probability</div>
  <div class="tut-ckey-row"><span class="tut-dot orange"></span> Orange (40–69%) — medium probability, attention needed</div>
  <div class="tut-ckey-row"><span class="tut-dot red"></span> Red (&lt; 40%) — low probability, critical situation</div>
  <div class="tut-ckey-row"><span class="tut-dot orange-border"></span> Orange border — probability changed by an activity (Impact Simulation active)</div>
</div>

<h3>Expand / Collapse Subtrees</h3>
<p>
  Each non-leaf paragon shows a ▼/▶ toggle button below the node. Click it to collapse or expand
  the entire subtree. Right-click for bulk options: <em>Collapse Children</em>, <em>Expand All</em>, etc.
</p>

<h3>Cross-DM References</h3>
<p>
  A paragon from one Dependency Model can be referenced inside another. This creates a
  <em>proxy node</em> (shown with a dashed border and ↗ badge) in the target DM.
  The proxy's probability is always computed from its source in the original DM.
</p>
<p>To add a cross-DM reference:</p>
<ul>
  <li><strong>Drag-and-drop</strong>: drag a paragon item from the Model Explorer directly onto the DM canvas.
    Drop onto an existing node to add it as a child, or drop onto empty canvas to add it as a standalone reference.</li>
  <li><strong>Context menu</strong>: right-click a node → <em>🌐 Add cross-DM child…</em> to use the selection dialog.</li>
</ul>

<h3>Layout &amp; Navigation</h3>
<ul>
  <li><kbd>Auto Layout</kbd> arranges nodes into a clean tree.</li>
  <li><kbd>Fit View</kbd> zooms/pans to show all nodes.</li>
  <li>Scroll to zoom; drag empty background to pan.</li>
  <li>Drag any node to reposition it manually.</li>
</ul>

<h3>Impact Simulation</h3>
<p>
  Click <kbd>Simulate Impacts</kbd> in the DM toolbar to apply all ActivityImpacts as probability
  overrides. Changed nodes show an orange border and ▲ badge.
</p>

<!-- 6 -->
<h2 id="tut-playbook">6. Playbook</h2>

<h3>Creating a Playbook</h3>
<ol>
  <li>Go to the <em>Playbooks</em> tab.</li>
  <li>Click <kbd>+ Org</kbd> in the toolbar to create an Organisation.</li>
  <li>Click <kbd>+ Playbook</kbd> to add a root playbook process to the organisation.</li>
  <li>Click <kbd>+ Activity</kbd> in the toolbar to add activities at the current view level.</li>
  <li>Right-click a node → <em>+ Sub-activity</em> to add a child specifically under that node.</li>
</ol>

<h3>Activity Properties</h3>
<p>Select an activity to view and edit its properties:</p>
<ul>
  <li><strong>Name</strong>, <strong>Notes</strong></li>
  <li><strong>Objectives</strong> — Investigation / Mitigation / Remediation / Prevention</li>
  <li><strong>Action Type</strong> — Manual / Automatic / Dual / Unknown</li>
  <li><strong>Status</strong> — Unspecified / In Progress / Completed</li>
  <li><strong>Dates</strong> — planned start and end dates</li>
  <li><strong>Roles</strong> — organisational roles responsible for this activity</li>
  <li><strong>Actuators</strong> — specific human or machine resources</li>
  <li><strong>Activity Impacts (CiO)</strong> — operational impacts on DM paragons</li>
  <li><strong>Sub-Activities</strong> — list of child activities with add/delete controls</li>
  <li><strong>External References</strong> — standards, policies, regulations</li>
</ul>

<h3>Connections (Data Flows)</h3>
<p>
  A blue dot is visible on the right edge of every activity. Drag from this dot to another
  activity to create a data flow (ArtifactStateInstance).
</p>

<h3>Drill Down</h3>
<p>
  Activities with sub-processes show a count badge. Double-click to drill down. Use the
  breadcrumb trail or <kbd>↑ Up</kbd> to navigate back.
</p>

<!-- 7 -->
<h2 id="tut-impact">7. Connecting Playbook and Dependency Model</h2>

<h3>ActivityImpact: the Cross-Model Link</h3>
<p>
  An ActivityImpact expresses: <em>"When activity X executes, the probability of paragon Y
  changes to value Z."</em> This is how operational context informs playbook design.
</p>

<h3>Via Properties Panel</h3>
<ol>
  <li>Select an activity in the Playbooks view.</li>
  <li>Scroll to <em>Activity Impacts (CiO)</em> in the Properties panel.</li>
  <li>Click <kbd>+ Add Impact</kbd>, select a paragon, set the new probability value, click OK.</li>
</ol>

<h3>Via Impact View (Graphical)</h3>
<ol>
  <li>Go to the <em>Impact View</em> tab and select the playbook and DM.</li>
  <li>Click <kbd>⛓ Connect</kbd> to enter Connect Mode.</li>
  <li>Drag from the <span style="color:#a855f7">purple circle</span> on an activity's right edge
      to the <span style="color:#2ecc71">green circle</span> on a paragon's left edge.</li>
  <li>Set the new probability in the dialog and click OK.</li>
</ol>
<p>
  Arrows to paragons from <em>other</em> dependency models are fully supported — if a proxy node
  for the target paragon exists in the currently displayed DM, the arrow will be drawn to it.
</p>

<!-- 8 -->
<h2 id="tut-impactview">8. Impact View</h2>

<p>
  The Impact View shows the playbook (left pane) and a dependency model (right pane)
  side-by-side, with red ActivityImpact arrows crossing between them.
  It enables analysts to visually reason about how incident response actions affect
  operational goals.
</p>

<h3>Basic Interaction</h3>
<ul>
  <li><strong>Click an activity</strong>: simulates that activity's impacts live in the DM.
    Changed paragons show <em>original → simulated</em> probability, orange border, ▲ badge.</li>
  <li><strong>Click a paragon</strong>: highlights all activities that have impacts on it.</li>
  <li><strong>Click empty space</strong>: clears selection and resets simulation.</li>
  <li><strong>Right-click an arrow</strong>: edit value or delete the connection.</li>
  <li><strong>Drag the centre divider</strong>: resize the playbook vs. DM panes.</li>
</ul>

<h3>DM Pane Controls</h3>
<ul>
  <li>Scroll to <strong>zoom</strong> the DM pane; drag empty background to <strong>pan</strong>.</li>
  <li>Click ▶/▼ toggles on paragon nodes to collapse/expand subtrees.</li>
  <li><kbd>⊡ Fit DM</kbd> resets zoom/pan to show the whole DM.</li>
  <li><kbd>Auto Layout</kbd> reflows the DM tree layout.</li>
</ul>

<h3>Execute Mode (⚡)</h3>
<p>
  Click <kbd>⚡ Execute</kbd> to enter Execute Mode. In this mode:
</p>
<ul>
  <li>Click any activity to mark it as <strong>executed</strong> (green border, ✓ badge).
    Click again to un-execute.</li>
  <li>Executing a composite activity also executes all its descendants.</li>
  <li>The DM shows the <strong>cumulative</strong> probability changes from all executed activities.</li>
</ul>

<h3>Step-by-Step Mode (⏯)</h3>
<p>
  Click <kbd>⏯ Step</kbd> to enter Step Mode. A Prev / Next toolbar appears with a step counter
  (e.g. <em>Step 3 / 12</em>).
</p>
<ul>
  <li>Activities are flattened into a depth-first queue. Each <kbd>Next</kbd> applies the next
    activity's impacts <strong>cumulatively</strong> to the DM.</li>
  <li>Click any activity directly in the list to <strong>jump</strong> to that step.</li>
  <li>Collapsed ancestors are automatically expanded when stepping to a hidden activity.</li>
  <li>Current step: amber border, ▶ badge. Past steps: green ✓ badge.</li>
</ul>

<h3>Snapshots in the Impact View</h3>
<p>
  Click <kbd>📸 Snapshot</kbd> during simulation to capture the current probability values and
  activity statuses as a named snapshot. See Section 11 for full details.
</p>

<h3>Connect Mode</h3>
<p>
  Click <kbd>⛓ Connect</kbd>. Drag from a blue handle (activity right-edge) to a green handle
  (paragon left-edge) to create a new ActivityImpact.
</p>

<!-- 9 -->
<h2 id="tut-metrics">9. Metrics View</h2>

<p>Click the <em>Metrics</em> tab to see a full metrics report for all dependency models.</p>

<h3>The Paragon Table</h3>
<p>Each row shows:</p>
<ul>
  <li><strong>Paragon</strong> — name with depth indentation (cross-DM proxy nodes show ↗ source name and DM)</li>
  <li><strong>Type</strong> — AND / OR / UNCONTROLLABLE</li>
  <li><strong>Probability</strong> — computed value with colour bar</li>
  <li><strong>CiO</strong> — Change in Operations: P_after − P_before for the selected activity scope</li>
  <li><strong>Critical Threshold Alert</strong> — current or planned breach status</li>
</ul>
<p>
  <strong>Click any row</strong> to view and edit that paragon's properties in the right panel.
  The clicked row highlights in blue.
</p>

<h3>Activity Impacts Table</h3>
<p>
  Below the paragon table, a second table lists each ActivityImpact. Click any row to view
  that activity's properties.
</p>

<h3>Interpreting CiO</h3>
<ul>
  <li><strong>Positive CiO (+x%)</strong>: the selected activities collectively increase this node's operational probability by x%. The response is beneficial for this component.</li>
  <li><strong>Negative CiO (−x%)</strong>: the activities degrade this node's probability. This may be an acceptable trade-off (e.g., temporarily shutting down a system to apply a patch).</li>
  <li><strong>Zero CiO (0%)</strong>: the activities have no direct or indirect effect on this node.</li>
</ul>
<div class="tut-note">
  <strong>Scope selector:</strong> Use the <em>CiO scope</em> dropdown in the Metrics toolbar to compute CiO
  with respect to all activities or a specific playbook. This lets you compare the operational impact of
  different response playbooks on the same dependency model.
</div>
<div class="tut-note">
  <strong>Propagation:</strong> CiO accounts for indirect effects. If activityA sets leafA from 0.4 → 0.9,
  every ancestor of leafA will show a non-zero CiO reflecting how that change propagates upward through
  the AND/OR tree.
</div>

<h3>Refresh</h3>
<p>
  Click <kbd>Refresh</kbd> in the Metrics toolbar to recompute all values. The Metrics view
  also refreshes automatically when a Snapshot is applied or the model is reset.
</p>

<!-- 10 -->
<h2 id="tut-ct">10. Critical Threshold &amp; Stakeholder Notifications</h2>

<p>
  A Critical Threshold (CT) defines the <em>minimum acceptable operational probability</em>
  for a paragon. It is optional and per-paragon.
</p>

<h3>Setting Up a Threshold</h3>
<ol>
  <li>Select a paragon in the Dependency Model view.</li>
  <li>In the Properties panel, scroll to <em>Critical Threshold &amp; Notifications</em>.</li>
  <li>Check <em>Enable Critical Threshold</em> and set the minimum probability (e.g. 0.7).</li>
  <li>Choose <em>Notify Mode</em>: <strong>Notify Only</strong> or <strong>Request Approval</strong>.</li>
  <li>Click <kbd>+ Add Stakeholder</kbd>. Choose an existing project Role (auto-fills name)
    or enter name/contact manually.</li>
</ol>

<h3>Threshold Alerts</h3>
<ul>
  <li><span style="color:#e74c3c">⚠ BELOW THRESHOLD</span> — current probability is already below CT.</li>
  <li><span style="color:#f39c12">⚠ PLANNED BREACH</span> — current probability is acceptable but
    defined ActivityImpacts would reduce it below CT if executed.</li>
</ul>
<p>Both alerts appear in the Properties panel (selected paragon) and in the Metrics table.</p>

<!-- 11 -->
<h2 id="tut-snapshots">11. Snapshots</h2>

<p>
  A <em>Snapshot</em> captures the <strong>complete operational state</strong> of all models
  at a specific point in time: every paragon's <code>leafProbability</code> and every
  activity's <code>status</code>. Snapshots are saved inside the project JSON file under a
  <code>snapshots</code> array.
</p>

<h3>Creating a Snapshot</h3>
<ul>
  <li>Click <kbd>📸 Snapshot</kbd> in the Impact View toolbar at any time — during simulation or without any active simulation.</li>
  <li>Enter a descriptive label (e.g. <em>After containment phase — Hour 4</em>).</li>
  <li>The snapshot appears in the <em>Snapshots</em> section of the Model Explorer.</li>
</ul>

<h3>Applying a Snapshot</h3>
<ul>
  <li>In the Model Explorer, locate the snapshot under the <em>Snapshots</em> section.</li>
  <li>Click the <strong>▶ (Load)</strong> button on the right of the snapshot row.</li>
  <li>All paragon probabilities and activity statuses are immediately restored to the captured state.</li>
  <li>The DM, Playbook, Impact View, and Metrics all update automatically.</li>
</ul>
<p>
  The <strong>first time</strong> any snapshot is applied, a <em>baseline</em> is automatically
  captured — recording the state of the model before any snapshot was ever applied.
</p>

<h3>Reset to Original</h3>
<p>
  After at least one snapshot has been applied, a <strong>↩ Reset to Original</strong>
  button appears at the top of the Snapshots section in the Model Explorer. Clicking it
  restores the baseline state (the model before any snapshot was ever applied), letting you
  undo all snapshot applications and start fresh.
</p>

<h3>Viewing Snapshot Details</h3>
<p>
  Click the snapshot label in the Model Explorer to view its properties in the right panel:
  creation time, list of completed activities, and a before/after comparison of paragon
  probabilities (colour-coded by change direction).
</p>

<h3>Deleting a Snapshot</h3>
<p>
  Click the <strong>🗑</strong> button next to a snapshot row in the Model Explorer.
</p>

<!-- 12 -->
<h2 id="tut-symbiosis">12. SYMBIOSIS Module</h2>

<p>
  The SYMBIOSIS tab provides a Goal-Question-Metric (GQM) measurement framework.
  It links business objectives through security measurement goals to concrete metrics.
</p>

<ol>
  <li>Click the <em>SYMBIOSIS</em> tab.</li>
  <li>Click <kbd>Init SYMBIOSIS</kbd> to create the SYMBIOSIS model.</li>
  <li>Add Business Objectives (high-level goals).</li>
  <li>Add Security Measurement Goals (GQM questions, linked to business objectives).</li>
  <li>Add Security Metrics (measurable indicators).</li>
</ol>
<p>
  Business Objectives and Security Measurement Goals can each be linked to a DM paragon,
  connecting the measurement framework to the operational dependency model.
</p>

<!-- 13 -->
<h2 id="tut-files">13. Files &amp; Import/Export</h2>

<h3>Auto-Save</h3>
<p>
  RaccoonIR automatically saves the project to <code>localStorage</code> (debounced, 1.5 s after
  each change). On next page load, the last session is automatically restored.
</p>

<h3>Save / Open</h3>
<p>
  <kbd>Save</kbd> downloads a <code>.raccoon-ir.json</code> file containing both the
  information model and the representation data (positions, zoom). Use <kbd>Open</kbd> to load it.
  After saving or opening, the filename appears in the header toolbar; subsequent
  <kbd>Save</kbd> actions reuse that filename automatically.
</p>

<h3>Import</h3>
<p><kbd>Import</kbd> loads model-only files:</p>
<ul>
  <li><code>.dependencymodel</code> — SecMoF XML dependency model</li>
  <li><code>.raccoon</code> — SecMoF XML playbook</li>
  <li><code>.json</code> — RaccoonIR model-only JSON export</li>
</ul>

<h3>Export Model</h3>
<p>
  <kbd>Export Model</kbd> saves a JSON file with only the information model (no layout data),
  suitable for sharing or archiving.
</p>

<!-- 14 -->
<h2 id="tut-examples">14. Example Projects</h2>

<p>
  All example projects are in the <code>examples/</code> subfolder. Open any of them via
  <kbd>Library</kbd> in the header toolbar (fetches the manifest and lets you click to load),
  or via <kbd>Open</kbd> if you have the files locally.
</p>

<table style="width:100%;border-collapse:collapse;font-size:12px">
  <thead><tr style="background:var(--bg-secondary)">
    <th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--border)">File</th>
    <th style="padding:6px 10px;text-align:left;border-bottom:1px solid var(--border)">Scenario</th>
  </tr></thead>
  <tbody>
    <tr><td style="padding:5px 10px;border-bottom:1px solid var(--border)"><code>phishing-t1566.json</code></td>
        <td style="padding:5px 10px;border-bottom:1px solid var(--border)"><strong>Phishing Attack Response</strong> — spearphishing IR with ATT&CK T1566/T1204/T1078 and D3FEND Email Removal, Homoglyph Detection, DNS Denylisting mappings.</td></tr>
    <tr><td style="padding:5px 10px;border-bottom:1px solid var(--border)"><code>ransomware-t1486.json</code></td>
        <td style="padding:5px 10px;border-bottom:1px solid var(--border)"><strong>Ransomware Incident Response</strong> — encryption impact, lateral movement containment, backup recovery. ATT&CK T1486/T1490/T1021. D3FEND Network Isolation, Backup Analysis.</td></tr>
    <tr><td style="padding:5px 10px;border-bottom:1px solid var(--border)"><code>password-spraying-t1110.json</code></td>
        <td style="padding:5px 10px;border-bottom:1px solid var(--border)"><strong>Password Spraying Attack</strong> — identity-focused response. ATT&CK T1110.003/T1078/T1087. D3FEND Account Locking, MFA, Credential Hardening.</td></tr>
    <tr><td style="padding:5px 10px;border-bottom:1px solid var(--border)"><code>process-injection-t1055.json</code></td>
        <td style="padding:5px 10px;border-bottom:1px solid var(--border)"><strong>Process Injection Response</strong> — DLL injection, process hollowing, memory analysis. ATT&CK T1055/T1059/T1003. D3FEND Memory Analysis, Process Spawn Analysis.</td></tr>
    <tr><td style="padding:5px 10px;border-bottom:1px solid var(--border)"><code>drive-by-compromise-t1189.json</code></td>
        <td style="padding:5px 10px;border-bottom:1px solid var(--border)"><strong>Drive-by Compromise Response</strong> — exploit kits, malicious redirects, C2 beaconing. ATT&CK T1189/T1203/T1071. D3FEND Web Filtering, Browser Isolation, URL Analysis.</td></tr>
  </tbody>
</table>

<p style="margin-top:12px">
  The <code>phishing-t1566.json</code> scenario demonstrates:
</p>
<ul>
  <li><strong>MITRE ATT&CK mappings</strong>: each activity references specific techniques (T1566.001, T1204.001, etc.) for threat context.</li>
  <li><strong>D3FEND countermeasures</strong>: defensive techniques (Email Removal, DNS Denylisting) linked to containment/eradication activities.</li>
  <li><strong>CiO analysis</strong>: the Email Gateway paragon has the highest CiO — blocking malicious senders has the largest positive operational impact.</li>
  <li><strong>Impact View simulation</strong>: step through the playbook to see how each action progressively improves system probability.</li>
</ul>

</div><!-- .tut-content -->
</div><!-- .tut-wrap -->
`;
  },

  /* ================================================================
   * METAMODELS
   * ================================================================ */

  _renderMetamodels(container) {
    const wrap = document.createElement('div');
    wrap.className = 'mm-wrap';

    // Package tabs
    const tabBar = document.createElement('div');
    tabBar.className = 'mm-pkg-tabs';

    const content = document.createElement('div');
    content.className = 'mm-pkg-content';

    RACCOON_METAMODEL.packages.forEach((pkg, i) => {
      const tab = document.createElement('button');
      tab.className = 'mm-pkg-tab' + (i === 0 ? ' active' : '');
      tab.textContent = pkg.label || pkg.name;
      tab.style.borderBottom = `3px solid ${pkg.border}`;
      tab.addEventListener('click', () => {
        tabBar.querySelectorAll('.mm-pkg-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        content.querySelectorAll('.mm-pkg-panel').forEach(p => p.classList.add('hidden'));
        content.querySelector('#mm-pkg-' + pkg.name).classList.remove('hidden');
      });
      tabBar.appendChild(tab);

      const panel = document.createElement('div');
      panel.className = 'mm-pkg-panel' + (i === 0 ? '' : ' hidden');
      panel.id = 'mm-pkg-' + pkg.name;
      this._renderPackagePanel(panel, pkg);
      content.appendChild(panel);
    });

    wrap.appendChild(tabBar);
    wrap.appendChild(content);

    // Footer — version + source
    const footer = document.createElement('div');
    footer.className = 'mm-footer';
    footer.innerHTML =
      `<strong>${RACCOON_METAMODEL.name}</strong> &nbsp;v${RACCOON_METAMODEL.version} &nbsp;&mdash;&nbsp; ` +
      RACCOON_METAMODEL.description;
    wrap.appendChild(footer);

    container.appendChild(wrap);
  },

  _renderPackagePanel(panel, pkg) {
    // Package header
    const hdr = document.createElement('div');
    hdr.className = 'mm-pkg-hdr';
    hdr.style.borderLeft = `4px solid ${pkg.border}`;
    hdr.innerHTML =
      `<div class="mm-pkg-name" style="color:${pkg.border}">${pkg.label || pkg.name}</div>` +
      `<div class="mm-pkg-source">Source: ${pkg.source}</div>` +
      `<div class="mm-pkg-desc">${pkg.description}</div>`;
    panel.appendChild(hdr);

    // Classes
    if (pkg.classes && pkg.classes.length) {
      const grid = document.createElement('div');
      grid.className = 'mm-class-grid';
      for (const cls of pkg.classes) {
        grid.appendChild(this._classCard(cls, pkg));
      }
      panel.appendChild(grid);
    }

    // Enumerations
    if (pkg.enumerations && pkg.enumerations.length) {
      const enumSec = document.createElement('div');
      enumSec.className = 'mm-enum-section';
      const enumTitle = document.createElement('div');
      enumTitle.className = 'mm-section-title';
      enumTitle.textContent = 'Enumerations';
      enumSec.appendChild(enumTitle);
      const enumGrid = document.createElement('div');
      enumGrid.className = 'mm-enum-grid';
      for (const en of pkg.enumerations) {
        enumGrid.appendChild(this._enumCard(en, pkg));
      }
      enumSec.appendChild(enumGrid);
      panel.appendChild(enumSec);
    }
  },

  _classCard(cls, pkg) {
    const card = document.createElement('div');
    card.className = 'mm-class-card';
    card.style.borderTop = `3px solid ${pkg.border}`;

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'mm-class-hdr';
    hdr.style.background = pkg.color;
    hdr.innerHTML =
      `<span class="mm-class-name">${cls.name}</span>` +
      (cls.abstract  ? '<span class="mm-badge mm-badge-abs">«abstract»</span>' : '') +
      (cls.supertype ? `<span class="mm-badge mm-badge-ext">extends ${cls.supertype}</span>` : '');
    card.appendChild(hdr);

    if (cls.description) {
      const desc = document.createElement('div');
      desc.className = 'mm-class-desc';
      desc.textContent = cls.description;
      card.appendChild(desc);
    }

    // Attributes
    if (cls.attributes && cls.attributes.length) {
      this._appendSection(card, 'Attributes', cls.attributes.map(a =>
        `<span class="mm-attr-name">${a.name}</span>` +
        `<span class="mm-attr-type">${a.type}</span>` +
        `<span class="mm-attr-mult">[${a.mult}]</span>` +
        (a.desc ? `<span class="mm-attr-desc"> — ${a.desc}</span>` : '')
      ));
    }

    // References
    if (cls.references && cls.references.length) {
      this._appendSection(card, 'References', cls.references.map(r =>
        `<span class="mm-attr-name">${r.name}</span>` +
        `<span class="mm-ref-arrow">&rarr;</span>` +
        `<span class="mm-ref-target">${r.target}</span>` +
        `<span class="mm-attr-mult">[${r.mult}]</span>` +
        (r.containment ? '<span class="mm-badge mm-badge-cont">◆</span>' : '') +
        (r.desc ? `<span class="mm-attr-desc"> — ${r.desc}</span>` : '')
      ));
    }

    // Derived attributes
    if (cls.derivedAttributes && cls.derivedAttributes.length) {
      this._appendSection(card, 'Derived (computed, not stored)', cls.derivedAttributes.map(d =>
        `<span class="mm-attr-name mm-derived">/&thinsp;${d.name}</span>` +
        `<span class="mm-attr-type">${d.type}</span>` +
        (d.desc ? `<span class="mm-attr-desc"> — ${d.desc}</span>` : '')
      ), 'mm-derived-section');
    }

    // Constraints
    if (cls.constraints && cls.constraints.length) {
      this._appendSection(card, 'Constraints', cls.constraints.map(c =>
        `<span class="mm-constraint">⚠ ${c}</span>`
      ), 'mm-constraint-section');
    }

    return card;
  },

  _enumCard(en, pkg) {
    const card = document.createElement('div');
    card.className = 'mm-enum-card';
    card.style.borderTop = `3px solid ${pkg.border}`;

    const hdr = document.createElement('div');
    hdr.className = 'mm-class-hdr';
    hdr.style.background = pkg.color;
    hdr.innerHTML =
      `<span class="mm-class-name">${en.name}</span>` +
      '<span class="mm-badge mm-badge-abs">«enum»</span>';
    card.appendChild(hdr);

    if (en.description) {
      const d = document.createElement('div');
      d.className = 'mm-class-desc';
      d.textContent = en.description;
      card.appendChild(d);
    }

    const list = document.createElement('ul');
    list.className = 'mm-enum-list';
    for (const v of en.values) {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="mm-enum-val">${v.name}</span>` +
        (v.desc ? `<span class="mm-attr-desc"> — ${v.desc}</span>` : '');
      list.appendChild(li);
    }
    card.appendChild(list);

    return card;
  },

  _appendSection(card, title, htmlRows, extraClass) {
    const sec = document.createElement('div');
    sec.className = 'mm-attr-sec' + (extraClass ? ' ' + extraClass : '');
    const t = document.createElement('div');
    t.className = 'mm-attr-sec-title';
    t.textContent = title;
    sec.appendChild(t);
    const ul = document.createElement('ul');
    ul.className = 'mm-attr-list';
    for (const row of htmlRows) {
      const li = document.createElement('li');
      li.innerHTML = row;
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    card.appendChild(sec);
  },

  /* ================================================================
   * ABOUT
   * ================================================================ */

  _renderAbout(container) {
    container.innerHTML = `
<div class="about-wrap">
  <div class="about-logo">🦝 RaccoonIR</div>
  <div class="about-subtitle">// Purple Team Incident Response Playbook Planner</div>

  <div class="about-section">
    <h3>What is RaccoonIR?</h3>
    <p>
      RaccoonIR is a browser-based modelling tool implementing the RaccoonIR metamodel for
      designing, analysing, and executing operations-informed incident response playbooks.
      It runs entirely in the browser — no server required — and is compatible with GitHub Pages.
      Built for purple teams who think like raccoons: resourceful, persistent, and always digging deeper.
    </p>
  </div>

  <div class="about-section">
    <h3>Metamodel Version</h3>
    <p>${RACCOON_METAMODEL.name} &mdash; v${RACCOON_METAMODEL.version}</p>
    <p style="color:var(--text-muted);font-size:11px">
      All information models created by this application strictly conform to this metamodel.
      The formal definition is available under the <em>Metamodels</em> tab.
    </p>
  </div>

  <div class="about-section">
    <h3>Academic References</h3>
    <ul class="about-refs">
      <li>
        <strong>Main paper (FRIPP):</strong><br>
        Shaked et al. (2023). <em>Operations-informed incident response playbooks.</em>
        Computers &amp; Security. — Defines FRIPP metamodel, ActivityImpact, CiO metric.
      </li>
      <li>
        <strong>FRIPP metamodel (ARES 2022):</strong><br>
        Shaked et al. (2022). <em>FRIPP — A metamodel for formalised response to incidents process playbooks.</em>
        ARES 2022. — Defines PlaybookProcess, Actuator, ActivityImpact, Organisation, Role.
      </li>
      <li>
        <strong>PROVE process model (ICED21):</strong><br>
        Shaked et al. (2022). <em>PROVE Tool.</em> ICED21. — Defines the artifact-centric
        process modelling foundation (Process, Artifact, ArtifactState, ArtifactStateInstance, Resource).
      </li>
      <li>
        <strong>Dependency Model (2022):</strong><br>
        Cherdantseva et al. (2022). <em>SCADA Dependency Model.</em> — Defines the
        AND/OR paragon tree and probability computation rules.
      </li>
    </ul>
  </div>

  <div class="about-section">
    <h3>Reference Implementation</h3>
    <p>
      RaccoonIR is inspired by <strong>SecMoF</strong>, an Eclipse-based reference implementation
      of the FRIPP metamodel. SecMoF source code is included in the
      <code>BackgroundMaterial/SecMoF-source/</code> folder.
    </p>
  </div>

  <div class="about-section">
    <h3>Metamodel Alignment Policy</h3>
    <p>
      The application enforces metamodel compliance at creation time:
    </p>
    <ul>
      <li>Cycles in Dependency Models are rejected.</li>
      <li>Paragon probability values are clamped to [0, 1].</li>
      <li>ActivityImpact.newValue is validated to be in [0, 1].</li>
      <li>All enumerations enforce their allowed values via dropdown controls.</li>
    </ul>
    <p>
      Any changes to <code>js/models.js</code> must be reflected in
      <code>js/metamodel-data.js</code> to maintain alignment.
    </p>
  </div>
</div>`;
  }
};
