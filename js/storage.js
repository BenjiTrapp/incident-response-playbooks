'use strict';
/* ============================================================
 * RaccoonIR Storage
 * Handles serialization/deserialization of projects to/from JSON.
 * The JSON format stores model and representation in separate sections.
 * Also supports importing model-only files (.dependencymodel, .raccoon)
 * ============================================================ */

const Storage = {

  /* ----------------------------------------------------------
   * Serialize full project (model + representation) to JSON
   * ---------------------------------------------------------- */
  serialize(project) {
    return JSON.stringify(project, null, 2);
  },

  /* ----------------------------------------------------------
   * Deserialize a full project JSON string
   * Applies defaults for any missing fields (forward-compat)
   * ---------------------------------------------------------- */
  deserialize(jsonString) {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (e) {
      throw new Error('Invalid JSON: ' + e.message);
    }

    // Ensure all top-level sections exist
    if (!data.name) data.name = 'Imported Project';
    if (!data.version) data.version = '1.0';

    // Model section
    const m = data.model = data.model || {};
    m.dependencyModels      = m.dependencyModels      || {};
    m.organisations         = m.organisations         || {};
    m.processes             = m.processes             || {};
    m.artifacts             = m.artifacts             || {};
    m.artifactStates        = m.artifactStates        || {};
    m.artifactStateInstances = m.artifactStateInstances || {};
    m.actuators             = m.actuators             || {};
    m.externalReferences    = m.externalReferences    || {};
    m.roles                 = m.roles                 || {};
    m.symbiosis             = m.symbiosis             || null;

    // Snapshots + baseline
    if (!Array.isArray(data.snapshots)) data.snapshots = [];
    if (data.baseline === undefined) data.baseline = null;

    // Representation section
    const r = data.representation = data.representation || {};
    r.dmViews = r.dmViews || {};
    r.pbViews = r.pbViews || {};

    // Ensure each DM has a view
    for (const dmId of Object.keys(m.dependencyModels)) {
      if (!r.dmViews[dmId]) r.dmViews[dmId] = createDMView();
    }
    // Ensure each root process has a view
    for (const org of Object.values(m.organisations)) {
      for (const pid of (org.rootProcessIds || [])) {
        if (!r.pbViews[pid]) r.pbViews[pid] = createPBView();
      }
    }

    return data;
  },

  /* ----------------------------------------------------------
   * Export model-only (no representation data)
   * Suitable for sharing / importing into other tools
   * ---------------------------------------------------------- */
  exportModelOnly(project) {
    return JSON.stringify({
      name: project.name,
      version: project.version,
      model: project.model
    }, null, 2);
  },

  /* ----------------------------------------------------------
   * Import model-only JSON into an existing project
   * Merges the model section; applies default representations
   * ---------------------------------------------------------- */
  importModelOnly(jsonString, project) {
    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (e) {
      throw new Error('Invalid JSON: ' + e.message);
    }
    if (data.model) {
      // Deep-merge model sections
      const m = data.model;
      for (const [key, val] of Object.entries(m)) {
        if (key === 'symbiosis') {
          project.model.symbiosis = val;
        } else if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          Object.assign(project.model[key] = project.model[key] || {}, val);
        }
      }
      // Create default representations for new elements
      this.applyDefaultRepresentations(project);
    }
    return project;
  },

  /* ----------------------------------------------------------
   * Apply default (auto-layout) representations for any
   * model elements that don't yet have representation data
   * ---------------------------------------------------------- */
  applyDefaultRepresentations(project) {
    for (const dmId of Object.keys(project.model.dependencyModels)) {
      if (!project.representation.dmViews[dmId]) {
        project.representation.dmViews[dmId] = createDMView();
      }
    }
    for (const org of Object.values(project.model.organisations)) {
      for (const pid of org.rootProcessIds) {
        if (!project.representation.pbViews[pid]) {
          project.representation.pbViews[pid] = createPBView();
        }
      }
    }
  },

  /* ----------------------------------------------------------
   * Import a SecMoF .dependencymodel XML file
   * ---------------------------------------------------------- */
  importDependencyModelXML(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    // Check for parse error
    if (doc.querySelector('parsererror')) {
      throw new Error('Invalid XML in dependency model file');
    }

    const root = doc.documentElement;
    const paragons = {};

    const parseParagon = (el) => {
      const p = createParagon(
        el.getAttribute('description') || 'Paragon',
        el.getAttribute('Type') || PARAGON_TYPE.UNCONTROLLABLE
      );
      const probAttr = el.getAttribute('probability');
      if (probAttr !== null && probAttr !== '') {
        p.leafProbability = Math.min(1, Math.max(0, parseFloat(probAttr)));
      }
      paragons[p.id] = p;

      const childEls = Array.from(el.children).filter(c => c.tagName === 'paragon');
      for (const childEl of childEls) {
        const child = parseParagon(childEl);
        p.childIds.push(child.id);
      }
      return p;
    };

    const rootParagon = parseParagon(root);

    // Determine a name from root description or default
    const dmName = rootParagon.description || 'Imported Dependency Model';

    return {
      id: uuid(),
      name: dmName,
      rootId: rootParagon.id,
      paragons
    };
  },

  /* ----------------------------------------------------------
   * Import a SecMoF .raccoon XML file (simplified import)
   * Creates a PlaybookProcess tree from the XMI
   * ---------------------------------------------------------- */
  importRaccoonXML(xmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    if (doc.querySelector('parsererror')) {
      throw new Error('Invalid XML in .raccoon file');
    }

    const root = doc.documentElement;
    const processes = {};
    const artifacts = {};
    const artifactStates = {};
    const artifactStateInstances = {};
    const actuators = {};

    // Parse resources from the root element
    const resourceEls = Array.from(root.children).filter(c => c.tagName === 'resource');
    for (const rEl of resourceEls) {
      const act = createActuator(
        rEl.getAttribute('name') || 'Actuator',
        (rEl.getAttribute('xsi:type') || '').includes('Actuator')
          ? (rEl.getAttribute('type') || ACTUATOR_TYPE_ENUM.HUMAN)
          : ACTUATOR_TYPE_ENUM.HUMAN
      );
      actuators[act.id] = act;
    }

    // Create root process
    const rootProc = createPlaybookProcess(root.getAttribute('name') || 'Imported Playbook');
    rootProc.notes = root.getAttribute('notes') || '';
    processes[rootProc.id] = rootProc;

    // Parse sub-processes recursively
    const parseProcess = (el, parentProc) => {
      const proc = createPlaybookProcess(el.getAttribute('name') || 'Activity');
      proc.notes = el.getAttribute('notes') || '';
      const aType = el.getAttribute('actionType');
      if (aType) proc.actionType = aType;
      processes[proc.id] = proc;
      if (parentProc) parentProc.subProcessIds.push(proc.id);

      const subEls = Array.from(el.children).filter(c => c.tagName === 'process');
      for (const sub of subEls) parseProcess(sub, proc);
      return proc;
    };

    const processEls = Array.from(root.children).filter(c => c.tagName === 'process');
    for (const pEl of processEls) {
      parseProcess(pEl, rootProc);
    }

    return {
      processes,
      artifacts,
      artifactStates,
      artifactStateInstances,
      actuators,
      rootProcessId: rootProc.id
    };
  },

  /* ----------------------------------------------------------
   * Trigger browser file download
   * ---------------------------------------------------------- */
  downloadJSON(content, filename) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /* ----------------------------------------------------------
   * Read a file selected via <input type="file">
   * Returns a Promise<string>
   * ---------------------------------------------------------- */
  readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }
};
