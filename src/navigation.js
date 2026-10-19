/**
 * Going back without loops. A page that opens a student's profile passes where
 * it was (state.from); the profile's Back returns there. Moving between the
 * profile and its intervention form replaces the history entry instead of
 * adding one, so Back never bounces between the two.
 */
export const here = (location) => `${location.pathname}${location.search}`;
export const backTo = (location, fallback = '/dashboard') => location.state?.from || fallback;
