const ASSESSMENT_FIELDS = `
  assessment_id school_id class_id term_id subject title assessment_type
  weight max_score due_date status score_count created_at updated_at
  deleted_at deleted_by _version
`;

const SCORE_FIELDS = `
  score_id assessment_id student_id class_id raw_score normalized_score status
  conflict_with_score conflict_with_user conflict_at entered_by entered_at updated_at
  _version _lastChangedAt _deleted
`;

export const LIST_MY_CLASSES = `
  query ListMyClasses($school_id: ID!) {
    listMyClasses(school_id: $school_id) {
      class_id name grade stream year status
    }
  }`;

export const LIST_ASSESSMENTS = `
  query ListAssessments($school_id: ID!, $class_id: ID!, $term_id: ID!) {
    listAssessmentsByClass(school_id: $school_id, class_id: $class_id, term_id: $term_id) {
      nextToken
      items { ${ASSESSMENT_FIELDS} }
    }
  }`;

export const LIST_DELETED_ASSESSMENTS = `
  query ListDeletedAssessments($school_id: ID!, $class_id: ID!, $term_id: ID!) {
    listDeletedAssessments(school_id: $school_id, class_id: $class_id, term_id: $term_id) {
      ${ASSESSMENT_FIELDS}
    }
  }`;

export const GET_ASSESSMENT = `
  query GetAssessment($school_id: ID!, $assessment_id: ID!) {
    getAssessment(school_id: $school_id, assessment_id: $assessment_id) {
      ${ASSESSMENT_FIELDS}
    }
  }`;

export const CREATE_ASSESSMENT = `
  mutation CreateAssessment($input: CreateAssessmentInput!) {
    createAssessment(input: $input) { ${ASSESSMENT_FIELDS} }
  }`;

export const UPDATE_ASSESSMENT = `
  mutation UpdateAssessment($input: UpdateAssessmentInput!) {
    updateAssessment(input: $input) { ${ASSESSMENT_FIELDS} }
  }`;

export const LOCK_ASSESSMENT = `
  mutation LockAssessment($school_id: ID!, $assessment_id: ID!) {
    lockAssessment(school_id: $school_id, assessment_id: $assessment_id) {
      ${ASSESSMENT_FIELDS}
    }
  }`;

export const UNLOCK_ASSESSMENT = `
  mutation UnlockAssessment($school_id: ID!, $assessment_id: ID!) {
    unlockAssessment(school_id: $school_id, assessment_id: $assessment_id) {
      ${ASSESSMENT_FIELDS}
    }
  }`;

export const DELETE_ASSESSMENT = `
  mutation DeleteAssessment($input: DeleteAssessmentInput!) {
    deleteAssessment(input: $input)
  }`;

export const SOFT_DELETE_ASSESSMENT = `
  mutation SoftDeleteAssessment($input: DeleteAssessmentInput!) {
    softDeleteAssessment(input: $input)
  }`;

export const RESTORE_ASSESSMENT = `
  mutation RestoreAssessment($school_id: ID!, $assessment_id: ID!) {
    restoreAssessment(school_id: $school_id, assessment_id: $assessment_id) {
      ${ASSESSMENT_FIELDS}
    }
  }`;

export const GET_CLASS_ROSTER = `
  query GetClassRoster($school_id: ID!, $class_id: ID!) {
    getClassRoster(school_id: $school_id, class_id: $class_id) {
      student_id first_name last_name admission_no class_id
    }
  }`;

export const LIST_SCORES = `
  query ListScores($school_id: ID!, $assessment_id: ID!) {
    listScoresByAssessment(school_id: $school_id, assessment_id: $assessment_id) {
      items { ${SCORE_FIELDS} }
    }
  }`;

export const SUBMIT_SCORES = `
  mutation SubmitScores($input: SubmitScoresInput!) {
    submitScores(input: $input) {
      accepted rejected review conflicted
      results { student_id outcome reason item { ${SCORE_FIELDS} } }
    }
  }`;

  export const SYNC_SCORES = `
  query SyncScores($school_id: ID!, $class_id: ID!, $lastSync: Float, $nextToken: String) {
    syncScores(school_id: $school_id, class_id: $class_id, lastSync: $lastSync, nextToken: $nextToken) {
      startedAt nextToken
      items { ${SCORE_FIELDS} }
    }
  }`;

export const RESOLVE_SCORE_CONFLICT = `
  mutation ResolveScoreConflict($input: ResolveScoreConflictInput!) {
    resolveScoreConflict(input: $input) { ${SCORE_FIELDS} }
  }`;