import { push } from '../offline/syncEngine.js';
import { useSync } from '../offline/useSync.js';

export default function SyncBar() {
  const { online, pending, failed, held } = useSync();
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  let message;
  if (!online && pending) message = `Offline. ${plural(pending, 'mark is', 'marks are')} saved on this device`;
  else if (!online) message = 'Offline. Marks you enter are saved on this device';
  else if (pending) message = `Saving ${plural(pending, 'mark', 'marks')}…`;
  else message = 'All marks saved';

  return (
    <div className={`syncbar ${online ? '' : 'offline'}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span>{message}</span>
      {failed > 0 && <span className="pill unrecorded">{plural(failed, 'mark', 'marks')} not saved</span>}
      {held > 0 && <span className="pill recording">{plural(held, 'mark', 'marks')} waiting for a decision</span>}
      {online && pending > 0 && (
        <button type="button" className="btn link" onClick={() => push()}>Sync now</button>
      )}
    </div>
  );
}