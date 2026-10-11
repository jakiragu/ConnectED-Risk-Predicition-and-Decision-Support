const ASSESSMENT_FIELDS = `
  assessment_id school_id class_id term_id subject title assessment_type paper_no
  weight max_score due_date status score_count created_at updated_at
  deleted_at deleted_by published_in _version
`;

const SCORE_FIELDS = `
  score_id assessment_id student_id class_id raw_score normalized_score mark_status status
  conflict_with_score conflict_with_mark_status conflict_with_user conflict_at entered_by entered_at updated_at
  _version _lastChangedAt _deleted
`;

export const LIST_MY_CLASSES = `
  query ListMyClasses($school_id: ID!) {
    listMyClasses(school_id: $school_id) {
      class_id name grade stream year status class_teacher_id my_subjects is_class_teacher
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

export const LIST_TERMS = `
  query ListTerms($school_id: ID!) {
    listTerms(school_id: $school_id) { term_id name start_date end_date status }
  }`;

// ------------------------------------------------------------------ results

const GRADE_RULE_FIELDS = `
  term_id pass_mark missing_score_policy
  checkpoint_weights { opener midterm endterm }
  checkpoint_weights_version checkpoint_weights_problems checkpoint_weights_locked
`;

const RESULT_SET_FIELDS = `
  school_id class_id term_id checkpoint kind status calculation_id subjects
  assessment_count student_count blocking
  issues { code severity message subject assessment_id student_id }
  calculated_at published_at event_status
  report_cards_status report_cards_generated report_cards_expected report_error
  checkpoint_weights { OPENER MIDTERM ENDTERM }
  _version
`;

const OUTCOME_FIELDS = `class_id class_name ok error_type message result_set { ${RESULT_SET_FIELDS} }`;

export const GET_GRADE_RULE = `
  query GetGradeRule($school_id: ID!, $term_id: ID!) {
    getGradeRule(school_id: $school_id, term_id: $term_id) { ${GRADE_RULE_FIELDS} }
  }`;

export const SET_CHECKPOINT_WEIGHTS = `
  mutation SetCheckpointWeights($input: SetCheckpointWeightsInput!) {
    setCheckpointWeights(input: $input) { ${GRADE_RULE_FIELDS} }
  }`;

export const LIST_RESULT_SETS = `
  query ListResultSets($school_id: ID!, $class_id: ID!, $term_id: ID!) {
    listResultSets(school_id: $school_id, class_id: $class_id, term_id: $term_id) { ${RESULT_SET_FIELDS} }
  }`;

export const LIST_CHECKPOINT_STATUS = `
  query ListCheckpointStatus($school_id: ID!, $term_id: ID!, $checkpoint: Checkpoint!) {
    listCheckpointStatus(school_id: $school_id, term_id: $term_id, checkpoint: $checkpoint) {
      class_id class_name result_set { ${RESULT_SET_FIELDS} }
    }
  }`;

export const GET_TERM_RESULTS = `
  query GetTermResults($school_id: ID!, $class_id: ID!, $term_id: ID!, $checkpoint: Checkpoint!) {
    getTermResults(school_id: $school_id, class_id: $class_id, term_id: $term_id, checkpoint: $checkpoint) {
      student_id checkpoint kind checkpoint_average term_average term_grade published published_at
      subjects {
        subject score earned covered assessed_count absent_count not_assessed_count missing_count
        papers { assessment_id title paper_no max_score weight mark_status raw_score percent contribution }
        term { weight_applied term_score grade components { checkpoint score weight } }
      }
    }
  }`;

export const CALCULATE_TERM_RESULTS = `
  mutation CalculateTermResults($input: CalculateTermResultsInput!) {
    calculateTermResults(input: $input) { ${RESULT_SET_FIELDS} }
  }`;

export const PUBLISH_RESULTS = `
  mutation PublishResults($input: PublishResultsInput!) {
    publishResults(input: $input) { ${RESULT_SET_FIELDS} }
  }`;

export const CALCULATE_SCHOOL_RESULTS = `
  mutation CalculateSchoolResults($input: CalculateSchoolResultsInput!) {
    calculateSchoolResults(input: $input) { ${OUTCOME_FIELDS} }
  }`;

export const PUBLISH_SCHOOL_RESULTS = `
  mutation PublishSchoolResults($input: PublishSchoolResultsInput!) {
    publishSchoolResults(input: $input) { ${OUTCOME_FIELDS} }
  }`;

// ------------------------------------------------------- people and classes

const TEACHER_FIELDS = `
  teacher_id school_id email first_name last_name role status class_teacher_of
  assignments { class_id subject } created_at updated_at _version
`;
const CLASS_FIELDS = `class_id name grade stream year status class_teacher_id class_teacher_name student_count _version`;
const STUDENT_FIELDS = `student_id first_name last_name admission_no class_id status _version`;

export const ME = `
  query Me($school_id: ID!) { me(school_id: $school_id) { ${TEACHER_FIELDS} } }`;

export const LIST_TEACHERS = `
  query ListTeachers($school_id: ID!) { listTeachers(school_id: $school_id) { ${TEACHER_FIELDS} } }`;

export const CREATE_TEACHER = `
  mutation CreateTeacher($input: CreateTeacherInput!) {
    createTeacher(input: $input) { teacher { ${TEACHER_FIELDS} } temporary_password }
  }`;

export const UPDATE_TEACHER = `
  mutation UpdateTeacher($input: UpdateTeacherInput!) { updateTeacher(input: $input) { ${TEACHER_FIELDS} } }`;

export const SET_TEACHER_ASSIGNMENTS = `
  mutation SetTeacherAssignments($input: SetTeacherAssignmentsInput!) {
    setTeacherAssignments(input: $input) { ${TEACHER_FIELDS} }
  }`;

export const SET_CLASS_TEACHER = `
  mutation SetClassTeacher($input: SetClassTeacherInput!) { setClassTeacher(input: $input) { ${CLASS_FIELDS} } }`;

export const DEACTIVATE_TEACHER = `
  mutation DeactivateTeacher($input: TeacherRefInput!) { deactivateTeacher(input: $input) { ${TEACHER_FIELDS} } }`;

export const REACTIVATE_TEACHER = `
  mutation ReactivateTeacher($input: TeacherRefInput!) { reactivateTeacher(input: $input) { ${TEACHER_FIELDS} } }`;

export const RESET_TEACHER_PASSWORD = `
  mutation ResetTeacherPassword($input: ResetTeacherPasswordInput!) {
    resetTeacherPassword(input: $input) { teacher { ${TEACHER_FIELDS} } temporary_password }
  }`;

export const LIST_SCHOOL_CLASSES = `
  query ListSchoolClasses($school_id: ID!) { listSchoolClasses(school_id: $school_id) { ${CLASS_FIELDS} } }`;

export const CREATE_CLASS = `
  mutation CreateClass($input: CreateClassInput!) { createClass(input: $input) { ${CLASS_FIELDS} } }`;

export const UPDATE_CLASS = `
  mutation UpdateClass($input: UpdateClassInput!) { updateClass(input: $input) { ${CLASS_FIELDS} } }`;

export const DELETE_CLASS = `
  mutation DeleteClass($input: DeleteClassInput!) { deleteClass(input: $input) }`;

export const LIST_STUDENTS = `
  query ListStudents($school_id: ID!, $class_id: ID!, $include_inactive: Boolean) {
    listStudents(school_id: $school_id, class_id: $class_id, include_inactive: $include_inactive) { ${STUDENT_FIELDS} }
  }`;

export const CREATE_STUDENT = `
  mutation CreateStudent($input: CreateStudentInput!) { createStudent(input: $input) { ${STUDENT_FIELDS} } }`;

export const UPDATE_STUDENT = `
  mutation UpdateStudent($input: UpdateStudentInput!) { updateStudent(input: $input) { ${STUDENT_FIELDS} } }`;

export const TRANSFER_STUDENT = `
  mutation TransferStudent($input: TransferStudentInput!) { transferStudent(input: $input) { ${STUDENT_FIELDS} } }`;

export const SET_STUDENT_STATUS = `
  mutation SetStudentStatus($input: SetStudentStatusInput!) { setStudentStatus(input: $input) { ${STUDENT_FIELDS} } }`;

// ------------------------------------------------------------ report cards

export const LIST_REPORT_CARDS = `
  query ListReportCards($school_id: ID!, $class_id: ID!, $term_id: ID!, $checkpoint: Checkpoint!) {
    listReportCards(school_id: $school_id, class_id: $class_id, term_id: $term_id, checkpoint: $checkpoint) {
      student_id admission_no first_name last_name student_status checkpoint kind available generated_at
    }
  }`;

export const REQUEST_REPORT_CARD_DOWNLOAD = `
  mutation RequestReportCardDownload($input: ReportCardDownloadInput!) {
    requestReportCardDownload(input: $input) { url file_name expires_at }
  }`;