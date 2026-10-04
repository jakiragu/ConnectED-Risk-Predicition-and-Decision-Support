/**
 * Every GraphQL document the app sends, in one file.
 *
 * Keeping them here rather than inline in components means the field lists can
 * be checked against graphql/schema/gradebook.graphql by eye, and the offline
 * repository in a later sprint has exactly one place to intercept.
 */

const ASSESSMENT_FIELDS = `
  assessment_id school_id class_id term_id subject title assessment_type
  weight max_score due_date status created_at updated_at _version
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

export const DELETE_ASSESSMENT = `
  mutation DeleteAssessment($input: DeleteAssessmentInput!) {
    deleteAssessment(input: $input)
  }`;