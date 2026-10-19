import { push } from '../offline/syncEngine.js';
import { useSync } from '../offline/useSync.js';

/**
 * Whether the work on this device has reached the server, in a few words:
 *   Up to date | Sending 3… | Offline · 3 waiting to send
 * plus, only when they exist, changes that were refused (with Retry) and marks
 * waiting for a decision because someone else changed them.
 */
export default function SyncBar() {
  const { online, pending, failed, held } = useSync();
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

  const message = !online
    ? `Offline${pending ? ` · ${pending} waiting to send` : ''}`
    : pending ? `Sending ${pending}…` : 'Up to date';

  return (
    <div className={`syncbar ${online ? '' : 'offline'}`} role="status" aria-live="polite"
      title={online ? undefined : 'Changes are kept on this device and sent when you reconnect'}>
      <span className="dot" aria-hidden="true" />
      <span>{message}</span>
      {failed > 0 && (
        <>
          <span className="pill unrecorded">{n(failed, 'change', 'changes')} not saved</span>
          {online && <button type="button" className="btn link" onClick={() => push()}>Retry</button>}
        </>
      )}
      {held > 0 && <span className="pill recording">{n(held, 'mark needs', 'marks need')} a decision</span>}
    </div>
  );
}
