import { handler as assessmentService } from '../backend/lambdas/assessment-service/handler.js';

export const RESOLVERS = {
  Query: {
    getAssessment: assessmentService,
    listAssessmentsByClass: assessmentService,
    listMyClasses: assessmentService,
  },
  Mutation: {
    createAssessment: assessmentService,
    updateAssessment: assessmentService,
    lockAssessment: assessmentService,
    deleteAssessment: assessmentService,
  },
};