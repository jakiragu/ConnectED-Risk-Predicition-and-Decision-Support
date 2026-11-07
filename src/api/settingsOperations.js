const POLICY_FIELDS = `
  school_id pass_mark missing_score_policy bands { grade min_score max_score }
  is_default updated_at updated_by_name _version
`;

export const GET_GRADING_POLICY = `
  query GetGradingPolicy($school_id: ID!) {
    getGradingPolicy(school_id: $school_id) { ${POLICY_FIELDS} }
  }`;

export const SAVE_GRADING_POLICY = `
  mutation SaveGradingPolicy($input: SaveGradingPolicyInput!) {
    saveGradingPolicy(input: $input) { ${POLICY_FIELDS} }
  }`;

export const SET_TERM_GRADING = `
  mutation SetTermGrading($input: SetTermGradingInput!) {
    setTermGrading(input: $input) {
      term_id pass_mark missing_score_policy bands { grade min_score max_score }
      grading_version grading_locked_reason grading_updated_at grading_updated_by_name
    }
  }`;

export const GET_GRADING_PREVIEW = `
  query GetGradingPreview($school_id: ID!) {
    getGradingPreview(school_id: $school_id) { term_id term_name marks }
  }`;

const CLASS_SETUP_FIELDS = 'school_id forms streams is_default updated_at _version';

export const GET_CLASS_SETUP = `
  query GetClassSetup($school_id: ID!) {
    getClassSetup(school_id: $school_id) { ${CLASS_SETUP_FIELDS} }
  }`;

export const SAVE_CLASS_SETUP = `
  mutation SaveClassSetup($input: SaveClassSetupInput!) {
    saveClassSetup(input: $input) { ${CLASS_SETUP_FIELDS} }
  }`;
