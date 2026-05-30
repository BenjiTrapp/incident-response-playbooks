'use strict';
/* ============================================================
 * RaccoonIR Formal Metamodel Definition
 *
 * This file is the authoritative definition of all metamodel
 * classes, attributes, references, enumerations, and constraints
 * implemented by the application. It serves two purposes:
 *
 *   1. Display: the Help > Metamodels viewer derives entirely
 *      from this structure — no duplication elsewhere.
 *
 *   2. Documentation: any change to models.js MUST be reflected
 *      here to keep the application aligned with its metamodel.
 *
 * Sources:
 *   DependencyModel — Cherdantseva et al. 2022, dependencyModel.ecore
 *   PROVE          — Shaked et al. 2022 (ICED21), PROVE.ecore
 *   FRIPP          — Shaked et al. 2023 (main paper), FRIPP.ecore (adapted as RaccoonIR)
 *   SYMBIOSIS      — symbiosisDM.ecore (measurement framework)
 *
 * Metamodel version: 1.2
 *   v1.0 — initial RaccoonIR/PROVE/DM implementation
 *   v1.1 — added Paragon.criticalThreshold, notifyMode, stakeholders;
 *           added STATUS_ENUM.IN_PROGRESS; explicit Stakeholder class
 *   v1.2 — added Stakeholder.roleId (optional reference to project Role)
 * ============================================================ */

const RACCOON_METAMODEL = {
  name: 'RaccoonIR Metamodel',
  version: '1.2',
  description:
    'Metamodel for Operations-Informed Incident Response Playbook Planning (RaccoonIR). ' +
    'Combines PROVE artifact-centric process modelling with Dependency Models (DM) ' +
    'and CiO-based operational metrics.',

  /* ----------------------------------------------------------------
   * Packages — one per source metamodel
   * ---------------------------------------------------------------- */
  packages: [

    /* ============================================================
     * DEPENDENCY MODEL PACKAGE
     * ============================================================ */
    {
      name:  'DependencyModel',
      label: 'Dependency Model',
      source: 'Cherdantseva et al. 2022 / dependencyModel.ecore',
      color:  '#0a2414',
      border: '#2ecc71',
      description:
        'Represents a system as a hierarchical (DAG) tree of paragons. ' +
        'Each paragon is a system goal or component. Probabilities propagate ' +
        'bottom-up using AND / OR logic. No cycles are permitted.',

      enumerations: [
        {
          name: 'PARAGON_TYPE',
          description: 'Composition rule applied when computing the paragon\'s probability from its children.',
          values: [
            { name: 'AND',            desc: 'P = ∏ P(child). All children must hold for this goal to hold.' },
            { name: 'OR',             desc: 'P = 1 − ∏(1−P(child)). At least one child must hold.' },
            { name: 'UNCONTROLLABLE', desc: 'Leaf probability is set directly; no AND/OR propagation.' }
          ]
        },
        {
          name: 'NOTIFY_MODE',
          description: 'Action required when a paragon\'s probability breaches its critical threshold.',
          values: [
            { name: 'NOTIFY_ONLY',       desc: 'Send a notification to assigned stakeholders.' },
            { name: 'REQUEST_APPROVAL',  desc: 'Halt the activity and request explicit stakeholder approval.' }
          ]
        }
      ],

      classes: [
        {
          name: 'DependencyModel',
          abstract: false,
          description: 'A named system dependency model. Contains a single root paragon and a flat map of all paragons.',
          attributes: [
            { name: 'id',   type: 'String', mult: '1',    desc: 'UUID — auto-generated.' },
            { name: 'name', type: 'String', mult: '1',    desc: 'Human-readable model name.' }
          ],
          references: [
            { name: 'root',     target: 'Paragon', mult: '1',    containment: true,  desc: 'The root goal of the tree.' },
            { name: 'paragons', target: 'Paragon', mult: '1..*', containment: true,  desc: 'All paragons in the model (flat map).' }
          ],
          constraints: [
            'The paragon graph MUST be acyclic (DAG). Cycles are rejected at creation time.'
          ]
        },
        {
          name: 'Paragon',
          abstract: false,
          description:
            'A system goal, capability, or component. Paragons form a DAG where ' +
            'probability flows from leaves to root via AND/OR rules.',
          attributes: [
            { name: 'id',                 type: 'String',       mult: '1',    desc: 'UUID.' },
            { name: 'description',        type: 'String',       mult: '1',    desc: 'Human-readable description of this goal/component.' },
            { name: 'type',               type: 'PARAGON_TYPE', mult: '1',    desc: 'AND, OR, or UNCONTROLLABLE.' },
            { name: 'leafProbability',    type: 'Float [0,1]',  mult: '0..1', desc: 'Probability used when this is a leaf or type=UNCONTROLLABLE.' },
            { name: 'criticalThreshold',  type: 'Float [0,1]',  mult: '0..1', desc: 'Optional. If computed P falls below this, stakeholders are alerted. Also checked against planned ActivityImpacts.' },
            { name: 'notifyMode',         type: 'NOTIFY_MODE',  mult: '1',    desc: 'What happens when threshold is breached. Default: NOTIFY_ONLY.' }
          ],
          references: [
            { name: 'children',     target: 'Paragon',     mult: '0..*', containment: false, desc: 'Child paragons (DAG edges, no cycles allowed).' },
            { name: 'stakeholders', target: 'Stakeholder', mult: '0..*', containment: true,  desc: 'People/roles to notify on threshold breach.' }
          ],
          derivedAttributes: [
            { name: 'computedProbability', type: 'Float [0,1]', desc: 'Computed from children via AND/OR rule, or equals leafProbability for leaves.' },
            { name: 'CiO',                 type: 'Float',       desc: 'Change in Operations: P_root(this=1) − P_root(this=0). Measures criticality.' }
          ]
        },
        {
          name: 'Stakeholder',
          abstract: false,
          description: 'A person or role to be notified when a paragon breaches its critical threshold. May optionally be linked to a Role defined in the PROVE model.',
          attributes: [
            { name: 'name',    type: 'String', mult: '1',    desc: 'Name or role title (e.g. CISO, System Owner). Auto-populated from linked Role if roleId is set.' },
            { name: 'contact', type: 'String', mult: '0..1', desc: 'Email address, phone, or other contact details.' }
          ],
          references: [
            { name: 'role', target: 'Role', mult: '0..1', containment: false, desc: 'Optional reference to a Role defined in the project. When linked, the stakeholder name is derived from the Role name.' }
          ]
        }
      ]
    },

    /* ============================================================
     * PROVE PACKAGE
     * ============================================================ */
    {
      name:  'PROVE',
      label: 'PROVE (Process)',
      source: 'Shaked et al. 2022 (ICED21) / PROVE.ecore',
      color:  '#0e1828',
      border: '#a855f7',
      description:
        'Artifact-centric process modelling framework. A Process produces and consumes ' +
        'Artifact state instances (data flows). Processes are hierarchical.',

      enumerations: [
        {
          name: 'STATUS_ENUM',
          description: 'Execution status of a process/activity.',
          values: [
            { name: 'UNSPECIFIED', desc: 'Not yet started or status unknown.' },
            { name: 'IN_PROGRESS', desc: 'Currently being executed.' },
            { name: 'COMPLETED',   desc: 'Execution finished.' }
          ]
        }
      ],

      classes: [
        {
          name: 'Process',
          abstract: true,
          description: 'Abstract base class for all activities. Extended by RaccoonIR PlaybookProcess.',
          attributes: [
            { name: 'id',        type: 'String',      mult: '1',    desc: 'UUID.' },
            { name: 'name',      type: 'String',      mult: '1',    desc: 'Activity name.' },
            { name: 'notes',     type: 'String',      mult: '0..1', desc: 'Free-text notes.' },
            { name: 'status',    type: 'STATUS_ENUM', mult: '1',    desc: 'Execution status.' },
            { name: 'startDate', type: 'Date',        mult: '0..1', desc: 'Planned start.' },
            { name: 'endDate',   type: 'Date',        mult: '0..1', desc: 'Planned end.' }
          ],
          references: [
            { name: 'subProcesses',        target: 'Process',               mult: '0..*', containment: true,  desc: 'Hierarchical child activities.' },
            { name: 'resourcesOwned',      target: 'Resource',              mult: '0..*', containment: true,  desc: 'Resources owned by this activity.' },
            { name: 'artifactsUsed',       target: 'ArtifactStateInstance', mult: '0..*', containment: false, desc: 'Data consumed by this activity.' },
            { name: 'artifactsProduced',   target: 'ArtifactStateInstance', mult: '0..*', containment: false, desc: 'Data produced by this activity.' }
          ]
        },
        {
          name: 'Resource',
          abstract: true,
          description: 'Abstract base for any resource used by a process. Extended by Actuator.',
          attributes: [
            { name: 'id',   type: 'String', mult: '1', desc: 'UUID.' },
            { name: 'name', type: 'String', mult: '1', desc: 'Resource name.' }
          ],
          references: []
        },
        {
          name: 'Artifact',
          abstract: false,
          description: 'A document, data item, or system artefact produced or consumed during the process.',
          attributes: [
            { name: 'id',   type: 'String', mult: '1', desc: 'UUID.' },
            { name: 'name', type: 'String', mult: '1', desc: 'Artifact name.' }
          ],
          references: [
            { name: 'states', target: 'ArtifactState', mult: '1..*', containment: true, desc: 'Possible states this artifact can be in.' }
          ]
        },
        {
          name: 'ArtifactState',
          abstract: false,
          description: 'A specific state that an artifact can occupy (e.g. Draft, Validated, Encrypted).',
          attributes: [
            { name: 'id',             type: 'String',  mult: '1', desc: 'UUID.' },
            { name: 'name',           type: 'String',  mult: '1', desc: 'State name.' },
            { name: 'achievedStatus', type: 'Boolean', mult: '1', desc: 'Whether this state has been reached.' }
          ],
          references: [
            { name: 'instances', target: 'ArtifactStateInstance', mult: '0..*', containment: true, desc: 'Flow tokens for this state.' }
          ]
        },
        {
          name: 'ArtifactStateInstance',
          abstract: false,
          description:
            'A flow token connecting two activities. Represents a specific occurrence of an artifact ' +
            'in a given state passing from one activity to another.',
          attributes: [
            { name: 'id', type: 'String', mult: '1', desc: 'UUID.' }
          ],
          references: [
            { name: 'originatingActivity', target: 'Process', mult: '0..1', containment: false, desc: 'Activity that produces this token (null = external input).' },
            { name: 'usedByActivity',      target: 'Process', mult: '0..1', containment: false, desc: 'Activity that consumes this token (null = external output).' }
          ]
        }
      ]
    },

    /* ============================================================
     * RACCOONIR PACKAGE
     * ============================================================ */
    {
      name:  'RaccoonIR',
      label: 'RaccoonIR (Playbook)',
      source: 'Based on Shaked et al. 2023 / FRIPP.ecore',
      color:  '#1e1000',
      border: '#f39c12',
      description:
        'Formalised Response to Incidents Process Playbook. Extends PROVE with ' +
        'IR-specific concepts: objectives, action types, roles, external references, ' +
        'and the critical ActivityImpact link to Dependency Models.',

      enumerations: [
        {
          name: 'OBJECTIVES_ENUM',
          description: 'IR lifecycle objective(s) addressed by a playbook activity.',
          values: [
            { name: 'INVESTIGATION', desc: 'Collect evidence and understand the incident.' },
            { name: 'MITIGATION',    desc: 'Reduce the impact of the incident.' },
            { name: 'REMEDIATION',   desc: 'Restore systems to their normal operational state.' },
            { name: 'PREVENTION',    desc: 'Prevent recurrence of the same incident type.' }
          ]
        },
        {
          name: 'ACTION_TYPE_ENUM',
          description: 'How the activity is executed.',
          values: [
            { name: 'MANUAL',    desc: 'Requires human execution.' },
            { name: 'AUTOMATIC', desc: 'Executed by a machine/script.' },
            { name: 'DUAL',      desc: 'Requires both human and machine.' },
            { name: 'UNKNOWN',   desc: 'Execution mode not yet specified.' }
          ]
        },
        {
          name: 'ACTUATOR_TYPE_ENUM',
          description: 'Type of agent that acts as a resource.',
          values: [
            { name: 'HUMAN',   desc: 'A person (analyst, responder, etc.).' },
            { name: 'MACHINE', desc: 'An automated system, tool, or script.' }
          ]
        },
        {
          name: 'REFERENCE_TYPE_ENUM',
          description: 'Category of an external reference.',
          values: [
            { name: 'BEST_PRACTICE', desc: 'Industry guideline (e.g. NIST, SANS).' },
            { name: 'POLICY',        desc: 'Organisational security policy.' },
            { name: 'REGULATION',    desc: 'Legal or regulatory requirement (e.g. GDPR).' }
          ]
        }
      ],

      classes: [
        {
          name: 'PlaybookProcess',
          abstract: false,
          supertype: 'Process (PROVE)',
          description:
            'A node in an incident response playbook. Extends PROVE Process with ' +
            'IR-specific metadata and the ActivityImpact link to the Dependency Model.',
          attributes: [
            { name: 'objectives',  type: 'OBJECTIVES_ENUM[]',  mult: '0..*', desc: 'IR objectives addressed by this activity.' },
            { name: 'actionType',  type: 'ACTION_TYPE_ENUM',   mult: '1',    desc: 'How the activity is executed.' }
          ],
          references: [
            { name: 'paragon',             target: 'Paragon',           mult: '0..1', containment: false, desc: 'DM node directly associated with this activity (planning link).' },
            { name: 'associatedRoles',     target: 'Role',              mult: '0..*', containment: false, desc: 'Roles responsible for executing this activity.' },
            { name: 'activityImpacts',     target: 'ActivityImpact',    mult: '0..*', containment: true,  desc: 'How executing this activity changes DM paragon probabilities.' },
            { name: 'externalReferences',  target: 'ExternalReference', mult: '0..*', containment: true,  desc: 'Standards / policies this activity is based on.' }
          ]
        },
        {
          name: 'Actuator',
          abstract: false,
          supertype: 'Resource (PROVE)',
          description: 'A concrete resource — either a human responder or an automated tool.',
          attributes: [
            { name: 'actuatorType', type: 'ACTUATOR_TYPE_ENUM', mult: '1', desc: 'HUMAN or MACHINE.' }
          ],
          references: []
        },
        {
          name: 'ActivityImpact',
          abstract: false,
          description:
            'Expresses how executing a PlaybookProcess changes the probability of a Paragon. ' +
            'This is the core cross-model link that enables CiO-based operational analysis.',
          attributes: [
            { name: 'id',       type: 'String',      mult: '1', desc: 'UUID.' },
            { name: 'newValue', type: 'Float [0,1]', mult: '1', desc: 'New probability value set on the paragon after activity execution.' }
          ],
          references: [
            { name: 'paragon', target: 'Paragon', mult: '1', containment: false, desc: 'The paragon whose probability is changed.' }
          ],
          derivedAttributes: [
            { name: 'originalProbability', type: 'Float [0,1]', desc: 'Current P before the activity (derived from DM at analysis time).' },
            { name: 'rootDelta',           type: 'Float',       desc: 'Change in root goal probability caused by this impact.' }
          ]
        },
        {
          name: 'ExternalReference',
          abstract: false,
          description: 'A reference to an external document, standard, policy, or regulation.',
          attributes: [
            { name: 'id',            type: 'String',               mult: '1', desc: 'UUID.' },
            { name: 'name',          type: 'String',               mult: '1', desc: 'Reference name or URL.' },
            { name: 'referenceType', type: 'REFERENCE_TYPE_ENUM',  mult: '1', desc: 'Category of the reference.' }
          ],
          references: []
        },
        {
          name: 'Role',
          abstract: false,
          description: 'An organisational role that can be assigned to playbook activities.',
          attributes: [
            { name: 'id',   type: 'String', mult: '1', desc: 'UUID.' },
            { name: 'name', type: 'String', mult: '1', desc: 'Role name (e.g. Incident Commander, SOC Analyst, CISO).' }
          ],
          references: []
        },
        {
          name: 'Organisation',
          abstract: false,
          description: 'Groups roles and top-level playbooks under an organisational unit.',
          attributes: [
            { name: 'id',   type: 'String', mult: '1', desc: 'UUID.' },
            { name: 'name', type: 'String', mult: '1', desc: 'Organisation name.' }
          ],
          references: [
            { name: 'roles',         target: 'Role',            mult: '0..*', containment: true,  desc: 'Roles defined within this organisation.' },
            { name: 'rootProcesses', target: 'PlaybookProcess', mult: '0..*', containment: false, desc: 'Top-level playbooks owned by this organisation.' }
          ]
        }
      ]
    },

    /* ============================================================
     * SYMBIOSIS PACKAGE
     * ============================================================ */
    {
      name:  'SYMBIOSIS',
      label: 'SYMBIOSIS (Metrics)',
      source: 'SYMBIOSIS measurement framework / symbiosisDM.ecore',
      color:  '#0e0a1e',
      border: '#9b59b6',
      description:
        'Goal-Question-Metric (GQM) measurement framework. Links organisational ' +
        'business objectives through security measurement goals down to concrete metrics ' +
        'and raw base measurements. Can be linked to DM paragons.',

      enumerations: [],

      classes: [
        {
          name: 'Symbiosis',
          abstract: false,
          description: 'Top-level container for the SYMBIOSIS measurement model.',
          attributes: [{ name: 'id', type: 'String', mult: '1', desc: 'UUID.' }],
          references: [
            { name: 'businessObjectives',       target: 'BusinessObjective',       mult: '0..*', containment: true,  desc: 'Organisational goals.' },
            { name: 'securityMeasurementGoals', target: 'SecurityMeasurementGoal', mult: '0..*', containment: true,  desc: 'GQM-style security goals.' },
            { name: 'securityMetrics',          target: 'SecurityMetric',          mult: '0..*', containment: true,  desc: 'Quantitative metrics.' },
            { name: 'baseMeasurements',         target: 'BaseMeasurement',         mult: '0..*', containment: true,  desc: 'Raw data collection definitions.' }
          ]
        },
        {
          name: 'BusinessObjective',
          abstract: false,
          description: 'A high-level organisational or security objective (GQM Goal level).',
          attributes: [
            { name: 'id',        type: 'String', mult: '1',    desc: 'UUID.' },
            { name: 'scope',     type: 'String', mult: '0..1', desc: 'Scope of the objective.' },
            { name: 'purpose',   type: 'String', mult: '0..1', desc: 'Intended purpose or outcome.' },
            { name: 'viewpoint', type: 'String', mult: '0..1', desc: 'Stakeholder viewpoint.' },
            { name: 'context',   type: 'String', mult: '0..1', desc: 'Organisational context.' }
          ],
          references: [
            { name: 'relatedObjectives', target: 'BusinessObjective', mult: '0..*', containment: false, desc: 'Other related business objectives.' },
            { name: 'paragon',           target: 'Paragon',           mult: '0..1', containment: false, desc: 'Linked DM goal (cross-model).' }
          ]
        },
        {
          name: 'SecurityMeasurementGoal',
          abstract: false,
          description: 'A GQM Question: a specific security goal to be measured.',
          attributes: [
            { name: 'id',        type: 'String', mult: '1',    desc: 'UUID.' },
            { name: 'scope',     type: 'String', mult: '0..1', desc: '' },
            { name: 'purpose',   type: 'String', mult: '0..1', desc: '' },
            { name: 'focus',     type: 'String', mult: '0..1', desc: 'Entity being measured.' },
            { name: 'criteria',  type: 'String', mult: '0..1', desc: 'Quality criteria.' },
            { name: 'viewpoint', type: 'String', mult: '0..1', desc: '' },
            { name: 'context',   type: 'String', mult: '0..1', desc: '' }
          ],
          references: [
            { name: 'businessObjectives', target: 'BusinessObjective', mult: '0..*', containment: false, desc: 'Business objectives this goal serves.' },
            { name: 'paragon',            target: 'Paragon',           mult: '0..1', containment: false, desc: 'Linked DM goal (cross-model).' }
          ]
        },
        {
          name: 'SecurityMetric',
          abstract: false,
          description: 'A GQM Metric: a quantitative measure derived from one or more SMGs.',
          attributes: [
            { name: 'id',                  type: 'String', mult: '1',    desc: 'UUID.' },
            { name: 'description',         type: 'String', mult: '0..1', desc: 'What this metric measures.' },
            { name: 'goal',                type: 'String', mult: '0..1', desc: 'Target value or direction.' },
            { name: 'method',              type: 'String', mult: '0..1', desc: 'Collection method.' },
            { name: 'measurementFunction', type: 'String', mult: '0..1', desc: 'Formula or aggregation.' },
            { name: 'interpretation',      type: 'String', mult: '0..1', desc: 'How to read the result.' },
            { name: 'reporting',           type: 'String', mult: '0..1', desc: 'Format / frequency.' }
          ],
          references: [
            { name: 'smgs',             target: 'SecurityMeasurementGoal', mult: '0..*', containment: false, desc: 'SMGs this metric addresses.' },
            { name: 'baseMeasurements', target: 'BaseMeasurement',         mult: '0..*', containment: false, desc: 'Raw measurements used.' }
          ]
        },
        {
          name: 'BaseMeasurement',
          abstract: false,
          description: 'A raw data collection activity or data point (GQM primitive).',
          attributes: [
            { name: 'id',          type: 'String', mult: '1',    desc: 'UUID.' },
            { name: 'description', type: 'String', mult: '0..1', desc: 'What raw data is being collected.' }
          ],
          references: []
        }
      ]
    }
  ]
};
