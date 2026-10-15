// GraphQL documents for risk predictions and the risk model.

export const LIST_RISK_PREDICTIONS = `
  query ListRiskPredictions($school_id: ID!, $class_id: ID!, $prediction_point: String!, $academic_year: Int) {
    listRiskPredictions(school_id: $school_id, class_id: $class_id, prediction_point: $prediction_point, academic_year: $academic_year) {
      student_id admission_no first_name last_name academic_year prediction_point probability at_risk threshold
      model_version missing_scores missing_attendance run_id predicted_at
    }
  }`;

export const GET_RISK_RUN = `
  query GetRiskRun($school_id: ID!, $class_id: ID!, $term_id: ID!, $checkpoint: Checkpoint!) {
    getRiskRun(school_id: $school_id, class_id: $class_id, term_id: $term_id, checkpoint: $checkpoint) {
      run_id status trigger model_version threshold students at_risk error started_at finished_at
    }
  }`;

export const GET_RISK_MODEL = `
  query GetRiskModel($school_id: ID!) {
    getRiskModel(school_id: $school_id) {
      available message model_version framework xgboost_version created_at source
      points { point features threshold metrics { f1 recall roc_auc } }
    }
  }`;

export const RUN_RISK_PREDICTIONS = `
  mutation RunRiskPredictions($input: RunRiskPredictionsInput!) {
    runRiskPredictions(input: $input) { run_id status trigger started_at }
  }`;