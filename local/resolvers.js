import { handler as assessmentService } from '../backend/lambdas/assessment-service/handler.js';
import { handler as gradingService } from '../backend/lambdas/grading-service/handler.js';
import { handler as resultsService } from '../backend/lambdas/results-service/handler.js';

export const RESOLVERS = {
  Query: {
    getAssessment: assessmentService,
    listAssessmentsByClass: assessmentService,
    listDeletedAssessments: assessmentService,
    listMyClasses: assessmentService,
    listTerms: assessmentService,
    getClassRoster: assessmentService,
    listScoresByAssessment: gradingService,
    syncScores: gradingService,
    getGradeRule: resultsService,
    listResultSets: resultsService,
    listCheckpointStatus: resultsService,
    getTermResults: resultsService,
  },
  Mutation: {
    createAssessment: assessmentService,
    updateAssessment: assessmentService,
    lockAssessment: assessmentService,
    unlockAssessment: assessmentService,
    deleteAssessment: assessmentService,
    softDeleteAssessment: assessmentService,
    restoreAssessment: assessmentService,
    submitScores: gradingService,
    resolveScoreConflict: gradingService,
    setCheckpointWeights: resultsService,
    calculateTermResults: resultsService,
    calculateSchoolResults: resultsService,
    publishResults: resultsService,
    publishSchoolResults: resultsService,
  },
};