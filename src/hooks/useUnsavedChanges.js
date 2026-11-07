import { useEffect } from 'react';
import { useBlocker } from 'react-router-dom';

export const UNSAVED_MESSAGE = 'You have unsaved changes on this page. Leave without saving them?';

/**
 * Guards unsaved work in two places:
 *   - inside the app (a link, the Back button, the sidebar): the navigation is
 *     paused and the person is asked whether to leave;
 *   - leaving the app (closing the tab, reloading): the browser's own warning.
 *
 * Only one guard can be active on a page at a time (a router supports one
 * blocker), so a page with several forms passes their combined state.
 *
 * @param {boolean} when     true while there is unsaved work
 * @param {string} [message] what the confirmation says
 */
export function useUnsavedChanges(when, message = UNSAVED_MESSAGE) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    Boolean(when) && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker, message]);

  useEffect(() => {
    if (!when) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [when]);
}
