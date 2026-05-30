'use strict';
/* ============================================================
 * RaccoonIR Data Models
 * Implements the metamodels from:
 *   - dependencyModel.ecore (Paragon, PARAGON_COMPOSITION_ENUM)
 *   - PROVE.ecore (Process, Artifact, ArtifactState, ArtifactStateInstance, Resource, STATUS_ENUM)
 *   - RaccoonIR.ecore (PlaybookProcess, Actuator, ExternalReference, ActivityImpact, Role, Organisation)
 *   - symbiosisDM.ecore (BusinessObjective, SecurityMeasurementGoal, SecurityMetric, BaseMeasurement)
 * ============================================================ */

/* ---- UUID ---- */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/* ============================================================
 * Enumerations
 * ============================================================ */
const PARAGON_TYPE = Object.freeze({
  AND: 'AND',
  OR: 'OR',
  UNCONTROLLABLE: 'UNCONTROLLABLE'
});

const OBJECTIVES_ENUM = Object.freeze({
  INVESTIGATION: 'INVESTIGATION',
  MITIGATION: 'MITIGATION',
  REMEDIATION: 'REMEDIATION',
  PREVENTION: 'PREVENTION'
});

const ACTION_TYPE_ENUM = Object.freeze({
  MANUAL: 'MANUAL',
  AUTOMATIC: 'AUTOMATIC',
  DUAL: 'DUAL',
  UNKNOWN: 'UNKNOWN'
});

const ACTUATOR_TYPE_ENUM = Object.freeze({
  HUMAN: 'HUMAN',
  MACHINE: 'MACHINE'
});

const REFERENCE_TYPE_ENUM = Object.freeze({
  BEST_PRACTICE: 'BEST_PRACTICE',
  POLICY: 'POLICY',
  REGULATION: 'REGULATION'
});

const STATUS_ENUM = Object.freeze({
  UNSPECIFIED:  'UNSPECIFIED',
  IN_PROGRESS:  'IN_PROGRESS',
  COMPLETED:    'COMPLETED'
});

const GOALS_ENUM = Object.freeze({
  MAKE_SYSTEM_SAFE: 'MAKE_SYSTEM_SAFE',
  PRESERVE_EVIDENCE: 'PRESERVE_EVIDENCE',
  ESTABLISH_COMMUNICATION: 'ESTABLISH_COMMUNICATION',
  MAKE_DECISION: 'MAKE_DECISION'
});

/* ============================================================
 * Dependency Model Factories
 * Paragon: a system component/goal in a hierarchical DAG
 * ============================================================ */

/**
 * Create a new Paragon node.
 * @param {string} description  Human-readable description
 * @param {string} type         PARAGON_TYPE value
 * @returns Paragon object
 */
function createParagon(description = 'New Paragon', type = PARAGON_TYPE.UNCONTROLLABLE) {
  return {
    id: uuid(),
    description,
    type,                   // AND | OR | UNCONTROLLABLE
    leafProbability: 1.0,   // Used when no children (leaf node) or UNCONTROLLABLE
    childIds: [],           // Ordered list of child paragon IDs (containment, tree structure)
    criticalThreshold: null,    // null = no CT; 0–1 minimum operational probability
    notifyMode: 'NOTIFY_ONLY',  // 'NOTIFY_ONLY' | 'REQUEST_APPROVAL'
    stakeholders: [],           // [{name, contact, roleId}] to notify when threshold breached
    proxyDMId: null,        // null = local node; set = this is a cross-DM reference
    proxyParagonId: null    // ID of the original paragon in proxyDMId
  };
}

/**
 * Create a proxy paragon — a cross-DM reference that lives in one DM but
 * delegates its probability to an original paragon in another DM.
 */
function createProxyParagon(dmId, paragonId) {
  const p = createParagon('(cross-DM reference)', PARAGON_TYPE.UNCONTROLLABLE);
  p.proxyDMId    = dmId;
  p.proxyParagonId = paragonId;
  return p;
}

/**
 * Create a new Dependency Model with a root paragon.
 * @param {string} name  Model name
 * @returns DependencyModel object
 */
function createDependencyModel(name = 'New Dependency Model') {
  const root = createParagon('Root Goal', PARAGON_TYPE.AND);
  return {
    id: uuid(),
    name,
    rootId: root.id,
    paragons: { [root.id]: root }  // flat map: id -> Paragon
  };
}

/* ============================================================
 * PROVE / RaccoonIR Model Factories
 * ============================================================ */

/** ArtifactStateInstance: represents one flow token between activities */
function createArtifactStateInstance(originatingActivity = null, usedByActivity = null) {
  return {
    id: uuid(),
    originatingActivity,  // process id (or null for root)
    usedByActivity        // process id (or null for root)
  };
}

/** ArtifactState: a specific state an artifact can be in */
function createArtifactState(name = 'undefined') {
  return {
    id: uuid(),
    name,
    artifactName: name,
    achievedStatus: false,
    instanceIds: []  // IDs of ArtifactStateInstances in this state
  };
}

/** Artifact: a document/data entity in the process */
function createArtifact(name = 'undefined') {
  return {
    id: uuid(),
    name,
    stateIds: []  // IDs of ArtifactStates
  };
}

/** Actuator (extends Resource): an agent that performs activities */
function createActuator(name = 'New Actuator', type = ACTUATOR_TYPE_ENUM.HUMAN) {
  return {
    id: uuid(),
    name,
    actuatorType: type  // HUMAN | MACHINE
  };
}

/** ExternalReference: a reference to an external document/standard */
function createExternalReference(name = '', type = REFERENCE_TYPE_ENUM.BEST_PRACTICE) {
  return {
    id: uuid(),
    name,
    referenceType: type  // BEST_PRACTICE | POLICY | REGULATION
  };
}

/**
 * ActivityImpact: describes how an activity changes a paragon's value.
 * originalType and originalProbability are derived at compute time.
 */
function createActivityImpact(paragonId = null, newValue = 1.0) {
  return {
    id: uuid(),
    paragonId,    // ref to Paragon id
    newValue      // new probability value after the activity
  };
}

/** Role: an organisational role that can be assigned to activities */
function createRole(name = 'New Role') {
  return { id: uuid(), name };
}

/**
 * PlaybookProcess (extends PROVE Process): a node in an incident response playbook.
 * Stores all PROVE base properties and RaccoonIR extensions.
 */
function createPlaybookProcess(name = 'New Activity') {
  return {
    id: uuid(),
    name,
    notes: '',
    // RaccoonIR extensions
    objectives: [],            // OBJECTIVES_ENUM[]
    actionType: ACTION_TYPE_ENUM.MANUAL,
    paragonId: null,           // ref to Paragon (link to DM)
    associatedRoleIds: [],     // Role ids
    activityImpacts: [],       // ActivityImpact[] (owned)
    externalReferences: [],    // ExternalReference[] (owned)
    relatedReferenceIds: [],   // ExternalReference ids (cross-refs)
    // MITRE ATT&CK / D3FEND mappings
    mitreTechniques: [],       // [{techniqueId, techniqueName, tactic, url}]
    mitreDefend: [],           // [{techniqueId, techniqueName, tactic, url}]
    // PROVE base
    status: STATUS_ENUM.UNSPECIFIED,
    startDate: null,
    endDate: null,
    subProcessIds: [],         // child PlaybookProcess ids
    resourceIds: [],           // Actuator ids (owned)
    resourceUsedIds: [],       // Actuator ids (cross-refs to org-level resources)
    artifactInStateUsedIds: [], // ArtifactStateInstance ids consumed by this activity
    resultArtifactInStateIds: [] // ArtifactStateInstance ids produced by this activity
  };
}

/** Organisation: groups roles and root-level playbook processes */
function createOrganisation(name = 'New Organisation') {
  return {
    id: uuid(),
    name,
    roleIds: [],        // Role ids
    rootProcessIds: []  // root PlaybookProcess ids
  };
}

/* ============================================================
 * SYMBIOSIS Model Factories
 * ============================================================ */

function createBusinessObjective() {
  return {
    id: uuid(),
    scope: '',
    purpose: '',
    viewpoint: '',
    context: '',
    relatedObjectiveIds: [],  // ids of other BusinessObjectives
    paragonId: null           // ref to Paragon
  };
}

function createSecurityMeasurementGoal() {
  return {
    id: uuid(),
    viewpoint: '',
    context: '',
    scope: '',
    purpose: '',
    focus: '',
    criteria: '',
    businessObjectiveIds: [],  // ids of BusinessObjectives
    paragonId: null
  };
}

function createSecurityMetric() {
  return {
    id: uuid(),
    description: '',
    goal: '',
    baseMeasurementIds: [],         // ids of BaseMeasurements
    method: '',
    measurementFunction: '',
    interpretation: '',
    reporting: '',
    smgIds: []  // SecurityMeasurementGoal ids
  };
}

function createBaseMeasurement() {
  return { id: uuid(), description: '' };
}

function createSymbiosis() {
  return {
    businessObjectives: {},       // id -> BusinessObjective
    securityMeasurementGoals: {}, // id -> SecurityMeasurementGoal
    securityMetrics: {},          // id -> SecurityMetric
    baseMeasurements: {},         // id -> BaseMeasurement
    dependencyModelParagonIds: [] // list of paragon ids linked to this SYMBIOSIS
  };
}

/* ============================================================
 * Project Factory — top-level container
 * Stores model data (separated from representations)
 * ============================================================ */
/**
 * Snapshot: a named capture of all paragon probabilities and activity statuses
 * at a specific point in time. Can be applied back to the model to restore that state.
 */
function createSnapshot(label, paragonProbabilities, activityStatuses) {
  return {
    id: uuid(),
    label,
    createdAt: new Date().toLocaleString(),  // user local time
    paragonProbabilities,  // { paragonId: leafProbability } — ALL paragons
    activityStatuses       // { processId: STATUS_ENUM }     — ALL activities
  };
}

function createProject(name = 'New Project') {
  return {
    name,
    version: '1.0',
    createdAt: new Date().toISOString(),
    snapshots: [],   // [ Snapshot, ... ]
    baseline: null,  // captured before the first snapshot is applied (enables Reset)
    /* ---- Information Model ---- */
    model: {
      dependencyModels: {},        // id -> DependencyModel
      organisations: {},           // id -> Organisation
      // Flat registries (global to project for easy lookup)
      processes: {},               // id -> PlaybookProcess
      artifacts: {},               // id -> Artifact
      artifactStates: {},          // id -> ArtifactState
      artifactStateInstances: {},  // id -> ArtifactStateInstance
      actuators: {},               // id -> Actuator
      externalReferences: {},      // id -> ExternalReference
      roles: {},                   // id -> Role
      symbiosis: null              // Symbiosis | null
    },
    /* ---- Representation Data ---- */
    representation: {
      dmViews: {},  // dmId -> { nodePositions: {paragonId -> {x,y}}, zoom, panX, panY }
      pbViews: {}   // processId -> { nodePositions: {subProcessId -> {x,y}}, zoom, panX, panY }
    }
  };
}

function createDMView() {
  return { nodePositions: {}, zoom: 1, panX: 0, panY: 0 };
}
function createPBView() {
  return { nodePositions: {}, zoom: 1, panX: 0, panY: 0 };
}

/* ============================================================
 * Registry & Lookup Helpers
 * ============================================================ */
const Registry = {
  /** Find which DependencyModel contains a given paragon ID */
  findDMForParagon(project, paragonId) {
    for (const dm of Object.values(project.model.dependencyModels)) {
      if (dm.paragons[paragonId]) return dm;
    }
    return null;
  },

  getParagon(project, id) {
    for (const dm of Object.values(project.model.dependencyModels)) {
      if (dm.paragons[id]) return dm.paragons[id];
    }
    return null;
  },

  getProcess(project, id) {
    return project.model.processes[id] || null;
  },

  getArtifact(project, id) {
    return project.model.artifacts[id] || null;
  },

  getArtifactState(project, id) {
    return project.model.artifactStates[id] || null;
  },

  getArtifactStateInstance(project, id) {
    return project.model.artifactStateInstances[id] || null;
  },

  getActuator(project, id) {
    return project.model.actuators[id] || null;
  },

  getRole(project, id) {
    return project.model.roles[id] || null;
  },

  getExternalReference(project, id) {
    return project.model.externalReferences[id] || null;
  },

  /** Get all paragons across all DMs as a flat map */
  allParagons(project) {
    const result = {};
    for (const dm of Object.values(project.model.dependencyModels)) {
      Object.assign(result, dm.paragons);
    }
    return result;
  },

  /** Get all root processes (direct children of organisations) */
  rootProcesses(project) {
    const roots = [];
    for (const org of Object.values(project.model.organisations)) {
      for (const pid of org.rootProcessIds) {
        const proc = project.model.processes[pid];
        if (proc) roots.push(proc);
      }
    }
    return roots;
  },

  /** Get the organisation that owns a root process */
  orgForProcess(project, rootProcessId) {
    for (const org of Object.values(project.model.organisations)) {
      if (org.rootProcessIds.includes(rootProcessId)) return org;
    }
    return null;
  },

  /** Get the parent process of a given process */
  parentProcess(project, processId) {
    for (const proc of Object.values(project.model.processes)) {
      if (proc.subProcessIds.includes(processId)) return proc;
    }
    return null;
  },

  /** Get all ancestor processes from root down to (not including) the given process */
  ancestors(project, processId) {
    const chain = [];
    let current = project.model.processes[processId];
    while (current) {
      const parent = this.parentProcess(project, current.id);
      if (!parent) break;
      chain.unshift(parent);
      current = parent;
    }
    return chain;
  },

  /** Get all connection edges for a given (root) process view */
  getEdgesForView(project, viewProcessId) {
    // Edges = ArtifactStateInstances where both endpoints are direct children
    // (or the view process itself is root/target)
    const proc = project.model.processes[viewProcessId];
    if (!proc) return [];
    const subSet = new Set([viewProcessId, ...proc.subProcessIds]);
    const edges = [];
    for (const inst of Object.values(project.model.artifactStateInstances)) {
      const from = inst.originatingActivity;
      const to = inst.usedByActivity;
      if ((from === null || subSet.has(from)) && (to === null || subSet.has(to))) {
        edges.push(inst);
      }
    }
    return edges;
  }
};

/* ============================================================
 * Model Validation
 * ============================================================ */
const ModelValidator = {
  /** Check if paragon creates a cycle when added as child of parentId */
  wouldCreateCycle(parentId, candidateId, paragons) {
    if (parentId === candidateId) return true;
    // Check if parentId is reachable from candidateId (candidateId is ancestor of parentId)
    return this._isReachable(candidateId, parentId, paragons, new Set());
  },

  _isReachable(fromId, toId, paragons, visited) {
    if (fromId === toId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);
    const node = paragons[fromId];
    if (!node) return false;
    for (const cid of node.childIds) {
      if (this._isReachable(cid, toId, paragons, visited)) return true;
    }
    return false;
  },

  validate(project) {
    const errors = [];
    // Validate dependency models
    for (const dm of Object.values(project.model.dependencyModels)) {
      for (const paragon of Object.values(dm.paragons)) {
        if (this.wouldCreateCycle(paragon.id, paragon.id, dm.paragons)) {
          errors.push(`Cycle detected in dependency model "${dm.name}" at paragon "${paragon.description}"`);
        }
      }
    }
    return errors;
  }
};
