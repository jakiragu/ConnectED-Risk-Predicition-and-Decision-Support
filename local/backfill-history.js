import 'dotenv/config';
import * as platform from '../backend/library/platformRepo.js';
import * as results from '../backend/library/resultsRepo.js';
import * as history from '../backend/library/historyRepo.js';

const schoolId = process.argv[2] || 'sch_saint_innocent';
let written = 0;
let skipped = 0;
for (const term of await platform.listTerms(schoolId)) {
  for (const set of await results.listSetsForTerm(schoolId, term.term_id)) {
    if (set.status !== results.STATUS.PUBLISHED || history.historyWritten(set)) {
      skipped++;
      continue;
    }
    const rows = await results.listRows(schoolId, set);
    await history.writeHistory(schoolId, set, rows, term);
    await history.markHistoryWritten(schoolId, set);
    written++;
    console.log(`history written: ${term.name} ${set.class_id} ${set.checkpoint} (${rows.length} students)`);
  }
}
console.log(`\n${written} published result sets backfilled, ${skipped} skipped`);