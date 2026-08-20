const STAGES = [
  { id: 'field-capture', label: 'Field capture', description: 'Capture the measured project quickly at the jobsite.' },
  { id: 'estimate-ready', label: 'Estimate ready', description: 'Confirm the core project geometry and relationships.' },
  { id: 'detailed-modeling', label: 'Detailed modeling', description: 'Enrich the same project with construction detail.' },
  { id: 'construction-ready', label: 'Construction ready', description: 'Complete the model for planning and takeoff.' },
];

export function getWorkflowStage(document) {
  return STAGES.find((stage) => stage.id === document.workflow?.stage) ?? STAGES[0];
}

export function getNextWorkflowStage(document) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === getWorkflowStage(document).id);
  return STAGES[Math.min(currentIndex + 1, STAGES.length - 1)];
}

export function deriveModelProgress(document) {
  const boundaries = document.objects.filter((object) => object.type === 'deck-boundary');
  const boundary = boundaries[0];
  const stairs = document.objects.filter((object) => object.type === 'stair');
  const railings = document.objects.filter((object) => object.type === 'railing-run');
  const established = boundaries.length > 0 && boundaries.every((entry) => entry.lifecycle?.phase === 'established');
  const milestones = [
    { id: 'boundary', label: 'Deck footprint', state: established ? 'complete' : boundary ? 'review' : 'next' },
    { id: 'relationships', label: 'Primary relationships', state: stairs.length || railings.length ? 'complete' : established ? 'next' : 'future' },
    { id: 'detail', label: 'Construction detail', state: railings.length ? 'complete' : stairs.length ? 'next' : 'future' },
    { id: 'takeoff', label: 'Materials & takeoff', state: 'future' },
  ];
  return {
    stage: getWorkflowStage(document),
    nextStage: getNextWorkflowStage(document),
    milestones,
    completedCount: milestones.filter((milestone) => milestone.state === 'complete').length,
  };
}

export { STAGES as WORKFLOW_STAGES };
