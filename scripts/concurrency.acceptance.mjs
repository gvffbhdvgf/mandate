import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

// Each Client below owns a distinct TCP connection to the same ephemeral Postgres instance.
// Expected domain rejections are captured immediately so the test runner never sees an unhandled promise.
const { Client } = pg;
const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) throw new Error('SUPABASE_DB_URL is required; run only against the disposable local Supabase database.');

const admin = new Client({ connectionString, application_name: 'mandate-concurrency-admin' });
const userId = randomUUID();
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tokens = [0, 1].map((i) => `mandate-concurrency-${suffix}-${i}-${'x'.repeat(32)}`);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const voterIds = [];
let organizationId;
let electionId;
let contestId;
let optionId;

async function client(name) {
  const c = new Client({ connectionString, application_name: name });
  await c.connect();
  return c;
}

async function withAuthenticated(c, fn) {
  await c.query('begin');
  await c.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
  await c.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await c.query('set local role authenticated');
  try {
    const result = await fn();
    await c.query('commit');
    return result;
  } catch (error) {
    await c.query('rollback');
    throw error;
  }
}

async function createFixture() {
  await admin.query('begin');
  await admin.query(`insert into auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_user_meta_data,created_at,updated_at)
    values ($1,'authenticated','authenticated',$2,'test-only',now(),jsonb_build_object('display_name','Concurrency Test'),now(),now())`, [userId, `concurrency-${suffix}@example.invalid`]);
  await admin.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
  await admin.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await admin.query('set local role authenticated');
  const org = await admin.query('select public.create_organization($1,$2,null,$3) as id', [`Concurrency Test ${suffix}`, `concurrency-${suffix}`, 'Africa/Nairobi']);
  organizationId = org.rows[0].id;
  const election = await admin.query(`select public.create_election_setup($1,$2::jsonb,$3::jsonb) as id`, [
    organizationId,
    JSON.stringify({ title: `Concurrency Election ${suffix}`, voting_mode: 'registered_single', starts_at: new Date(Date.now() - 60_000).toISOString(), ends_at: new Date(Date.now() + 3_600_000).toISOString(), timezone: 'Africa/Nairobi', result_visibility: 'private' }),
    JSON.stringify([{ title: 'Chairperson', options: [{ display_name: 'Candidate A' }, { display_name: 'Candidate B' }] }]),
  ]);
  electionId = election.rows[0].id;
  await admin.query('commit');

  const contest = await admin.query('select id from public.contests where election_id=$1', [electionId]);
  contestId = contest.rows[0].id;
  const option = await admin.query("select id from public.options where contest_id=$1 and display_name='Candidate A'", [contestId]);
  optionId = option.rows[0].id;

  for (let i = 0; i < tokens.length; i++) {
    const voter = await admin.query(`insert into public.election_voters(organization_id,election_id,external_voter_ref,display_name,normalized_email,access_token_hash,invited_at)
      values ($1,$2,$3,$4,$5,$6,now()) returning id`, [organizationId, electionId, `RACE-${i}`, `Race Voter ${i}`, `race-${i}-${suffix}@example.invalid`, digest(tokens[i])]);
    voterIds.push(voter.rows[0].id);
  }
  // Registered elections require a server-priced platform-fee invoice before opening.
  // Settle this fixture invoice directly as the disposable database owner; no provider
  // request or real payment is involved in the concurrency acceptance test.
  const feeIntentResult = await withAuthenticated(admin, async () => {
    const quote = await admin.query(
      'select public.get_platform_fee_quote($1) as quote', [electionId],
    );
    const feeQuote = quote.rows[0].quote;
    return admin.query(
      'select public.create_platform_fee_payment_intent($1,$2,$3,$4) as result',
      [electionId, feeQuote.eligibleVoterCount, feeQuote.amountMinor, feeQuote.policyVersion],
    );
  });
  const feeIntent = feeIntentResult.rows[0].result;
  await admin.query('begin');
  try {
    await admin.query('set local role service_role');
    await admin.query("select set_config('request.jwt.claim.role','service_role',true)");
    await admin.query(`update public.payment_intents
      set status='success',
          provider_transaction_id=$2,
          provider_status='success',
          provider_amount_minor=$3,
          provider_currency='KES',
          verified_at=now()
      where id=$1 and purpose='platform_fee' and status='initialized'`,
      [feeIntent.paymentIntentId, `test-fee-${suffix}`, feeIntent.amountMinor],
    );
    await admin.query('commit');
  } catch (error) {
    await admin.query('rollback');
    throw error;
  }
  const feeState = await admin.query(
    'select platform_fee_status from public.elections where id=$1', [electionId],
  );
  assert.equal(feeState.rows[0].platform_fee_status, 'paid', 'test-only verified fee payment must unlock election opening');

  const confirmation = await withAuthenticated(admin, async () => admin.query(
    'select public.confirm_election_setup($1) as result', [electionId],
  ));
  assert.equal(confirmation.rows[0].result.electionId, electionId, 'authority confirmation should be recorded before opening');

  const opened = await withAuthenticated(admin, async () => admin.query('select public.open_election($1,true)', [electionId]));
  assert.ok(opened.rows[0].open_election, 'election should open');
}

async function cast(token, name) {
  const c = await client(name);
  try {
    await c.query('set role anon');
    return await c.query('select public.cast_registered_ballot($1,$2,$3,true) as result', [token, contestId, optionId]);
  } finally {
    await c.end();
  }
}

async function main() {
  await admin.connect();
  try {
    await createFixture();

    // Two independent PostgreSQL sessions submit the same voter's ballot at once.
    const duplicate = await Promise.allSettled([
      cast(tokens[0], 'mandate-race-duplicate-a'),
      cast(tokens[0], 'mandate-race-duplicate-b'),
    ]);
    assert.equal(duplicate.filter((x) => x.status === 'fulfilled').length, 1, 'exactly one concurrent duplicate cast must succeed');
    assert.equal(duplicate.filter((x) => x.status === 'rejected').length, 1, 'the competing duplicate cast must fail');
    const duplicateError = duplicate.find((x) => x.status === 'rejected').reason;
    assert.match(duplicateError.message, /BALLOT_ALREADY_CAST/, 'duplicate cast should return the domain-specific rejection');
    const firstCount = await admin.query('select count(*)::int as count from public.ballots where election_id=$1', [electionId]);
    assert.equal(firstCount.rows[0].count, 1, 'only one ballot row may be committed for the voter');

    // Hold the election row lock, queue a second voter's cast behind it, pause while
    // retaining the lock, then commit. The waiting cast must observe paused state.
    const blocker = await client('mandate-race-pause-owner');
    const castClient = await client('mandate-race-pause-cast');
    try {
      await blocker.query('begin');
      await blocker.query('select id from public.elections where id=$1 for update', [electionId]);
      await castClient.query('set role anon');
      const waitingCast = castClient.query('select public.cast_registered_ballot($1,$2,$3,true)', [tokens[1], contestId, optionId])
        .then(() => ({ error: null }), (error) => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await admin.query("select wait_event_type from pg_stat_activity where application_name='mandate-race-pause-cast'");
        if (state.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(waiting, 'cast session should be blocked on the election row lock');
      await blocker.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
      await blocker.query("select set_config('request.jwt.claim.role','authenticated',true)");
      await blocker.query('set local role authenticated');
      await blocker.query("select public.pause_election($1,'Concurrency test controlled pause')", [electionId]);
      await blocker.query('commit');
      const pauseCastOutcome = await waitingCast;
      assert.match(pauseCastOutcome.error?.message ?? '', /ELECTION_NOT_OPEN/);
    } finally {
      await blocker.query('rollback').catch(() => {});
      await blocker.end();
      await castClient.end();
    }
    const finalState = await admin.query('select status from public.elections where id=$1', [electionId]);
    assert.equal(finalState.rows[0].status, 'paused', 'pause must be committed');
    const finalCount = await admin.query('select count(*)::int as count from public.ballots where election_id=$1', [electionId]);
    assert.equal(finalCount.rows[0].count, 1, 'a cast queued behind pause must not commit');

    await withAuthenticated(admin, async () => admin.query(
      "select public.resume_election($1,'Concurrency acceptance resume reason')", [electionId],
    ));

    // Repeat the controlled lock race with close rather than pause. The cast must
    // wait for the close transaction, then re-check status and reject.
    const closeBlocker = await client('mandate-race-close-owner');
    const closeCastClient = await client('mandate-race-close-cast');
    try {
      await closeBlocker.query('begin');
      await closeBlocker.query('select id from public.elections where id=$1 for update', [electionId]);
      await closeCastClient.query('set role anon');
      const waitingCloseCast = closeCastClient.query(
        'select public.cast_registered_ballot($1,$2,$3,true)', [tokens[1], contestId, optionId],
      ).then(() => ({ error: null }), (error) => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await admin.query("select wait_event_type from pg_stat_activity where application_name='mandate-race-close-cast'");
        if (state.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(waiting, 'cast session should be blocked on the election row lock before close');
      await closeBlocker.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
      await closeBlocker.query("select set_config('request.jwt.claim.role','authenticated',true)");
      await closeBlocker.query('set local role authenticated');
      await closeBlocker.query("select public.close_election($1,'Concurrency acceptance close reason')", [electionId]);
      await closeBlocker.query('commit');
      const closeCastOutcome = await waitingCloseCast;
      assert.match(closeCastOutcome.error?.message ?? '', /ELECTION_NOT_OPEN/);
    } finally {
      await closeBlocker.query('rollback').catch(() => {});
      await closeBlocker.end();
      await closeCastClient.end();
    }
    const closedState = await admin.query('select status from public.elections where id=$1', [electionId]);
    assert.equal(closedState.rows[0].status, 'closed', 'close must be committed');
    const closedCount = await admin.query('select count(*)::int as count from public.ballots where election_id=$1', [electionId]);
    assert.equal(closedCount.rows[0].count, 1, 'a cast queued behind close must not commit');

    const runTally = async (name) => {
      const c = await client(name);
      try {
        return await withAuthenticated(c, async () => c.query(
          'select public.tally_and_reconcile($1) as result', [electionId],
        ));
      } finally {
        await c.end();
      }
    };
    const tallies = await Promise.allSettled([
      runTally('mandate-race-tally-a'),
      runTally('mandate-race-tally-b'),
    ]);
    assert.equal(tallies.filter((x) => x.status === 'fulfilled').length, 2, 'both concurrent tally requests should resolve');
    const tallyIds = tallies.map((x) => x.value.rows[0].result.tallyId);
    assert.equal(tallyIds[0], tallyIds[1], 'concurrent tally requests must return the same idempotent tally');
    const tallyCount = await admin.query('select count(*)::int as count from public.election_tallies where election_id=$1', [electionId]);
    assert.equal(tallyCount.rows[0].count, 1, 'only one tally row may be created');

    console.log('PASS: independent-session duplicate ballot race (one accepted, one rejected)');
    console.log('PASS: pause wins election-row lock; queued ballot observes paused state');
    console.log('PASS: close wins election-row lock; queued ballot observes closed state');
    console.log('PASS: concurrent tally requests return one consistent tally');
  } finally {
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
