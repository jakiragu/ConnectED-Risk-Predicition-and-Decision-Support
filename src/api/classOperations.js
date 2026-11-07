const MOVE = 'student_id first_name last_name admission_no now before change';

export const GET_CLASS_PROFILE = `
  query GetClassProfile($school_id: ID!, $class_id: ID!, $term_id: ID!, $checkpoint: Checkpoint!) {
    getClassProfile(school_id: $school_id, class_id: $class_id, term_id: $term_id, checkpoint: $checkpoint) {
      class_id class_name term_id term_name academic_year checkpoint checkpoint_label
      published published_at viewer_is_admin viewer_is_class_teacher my_subjects form stream class_year class_teacher_name
      scope subjects student_count previous_label risk_point school_classes
      trend { label term_id checkpoint mean school_mean }
      performance_distribution { ranges series { checkpoint label counts students } }
      risk_distribution { ranges threshold series { checkpoint point label counts predicted flagged } }
      top_factors { factor share }
      intervention_methods { method factor frequency students }
      rules {
        pass_mark missing_score_policy bands { grade min_score max_score }
        checkpoint_weights { opener midterm endterm } opener_enabled labels { checkpoint label }
      }
      profile {
        summary { assessed mean mean_grade median mean_change pass_mark pass_rate pass_rate_change school_mean attendance_rate incomplete }
        distribution { label min max count previous_count }
        subject_results { subject count mean median q1 q3 min max pass_rate change school_mean incomplete }
        movement { compared risers { ${MOVE} } fallers { ${MOVE} } }
        risk {
          predicted flagged flagged_rate threshold model_version without_intervention
          students { student_id first_name last_name admission_no probability raised_by interventions }
        }
        students { student_id first_name last_name admission_no result grade change attendance probability at_risk interventions incomplete }
      }
    }
  }`;
