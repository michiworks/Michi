import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askUserScheduledJobApprover, type ScheduledJobApprovalRequest } from '../src/agents/scheduledJobTools';
import { askUserThreadMessageApprover } from '../src/agents/threadMessageTool';

const job: ScheduledJobApprovalRequest = {
  toolName: 'delete_scheduled_job', action: 'delete', jobName: 'Digest',
  title: 'Delete scheduled job “Digest”?', lines: ['Removes the job.'], approveLabel: 'Delete',
};
const message = { targetNodeId: 'n-b', targetTitle: 'Implementation', text: 'Please review' };

test('a single-use approval through ask_user: only the approve label approves, any other text is a note', async () => {
  const approvers = [
    { approve: 'Delete', decline: 'Cancel', ask: (reply: string | null) => askUserScheduledJobApprover(async (questions) =>
      reply === null ? null : { [questions[0].question]: reply })(job) },
    { approve: 'Send', decline: "Don't send", ask: (reply: string | null) => askUserThreadMessageApprover(async (questions) =>
      reply === null ? null : { [questions[0].question]: reply })(message) },
  ];
  for (const { approve, decline, ask } of approvers) {
    assert.deepEqual(await ask(approve), { approved: true }, approve);
    assert.deepEqual(await ask(` ${approve} `), { approved: true }, 'the label, trimmed');
    assert.deepEqual(await ask(approve.toLowerCase()), { approved: false, reason: 'declined', note: approve.toLowerCase() }, 'only the exact label');
    assert.deepEqual(await ask(decline), { approved: false, reason: 'declined' }, decline);
    assert.deepEqual(await ask(''), { approved: false, reason: 'declined' }, 'an empty answer');
    assert.deepEqual(await ask('x'.repeat(600)), { approved: false, reason: 'declined', note: 'x'.repeat(500) }, 'a typed answer, cut to 500');
    assert.deepEqual(await ask(null), { approved: false, reason: 'no_answer' }, 'skipped or timed out');
  }
  assert.deepEqual(await askUserScheduledJobApprover(undefined)(job), { approved: false, reason: 'unavailable' });
  assert.deepEqual(await askUserThreadMessageApprover(undefined)(message), { approved: false, reason: 'unavailable' });
});
