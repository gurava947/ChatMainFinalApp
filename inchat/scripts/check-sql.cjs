'use strict';

/**
 * Parses every migration with the real PostgreSQL grammar (libpg-query embeds
 * the server parser), including the bodies of plpgsql functions, which the
 * outer parse does not look inside.
 *
 * This is a syntax gate, not a semantics gate: it cannot tell you a policy
 * references a column that does not exist. Running the migrations against the
 * project and executing the RLS test suite is what covers that.
 *
 * The bundled grammar is PostgreSQL 18 while a Supabase project may run an
 * earlier major, so a statement this gate accepts still has to run on the
 * project before it counts as verified.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseSync, parsePlPgSQLSync, loadModule } = require('libpg-query');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const dirs = argv.filter((arg) => !arg.startsWith('--'));
const migrationDirs = dirs.length ? dirs : ['supabase/migrations'];

function filesIn(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(abs, name));
}

/**
 * Splits on semicolons that sit outside a quoted string, a dollar-quoted body,
 * or a comment. A naive split would cut the migrations apart mid-function.
 */
function splitStatements(sql) {
  const out = [];
  let current = '';
  let line = 1;
  let startLine = 1;

  const skipLineComment = (i) => {
    while (i < sql.length && sql[i] !== '\n') i += 1;
    return i;
  };

  let i = 0;
  let started = false;

  // A statement's reported line is where its first real character sits, not
  // where the previous semicolon was; otherwise the error points past the code.
  const emit = (chunk) => {
    if (!started && chunk.trim()) {
      started = true;
      startLine = line;
    }
    current += chunk;
  };

  while (i < sql.length) {
    const rest = sql.slice(i);

    const dollar = /^\$\$/.exec(rest);
    if (dollar) {
      const close = sql.indexOf('$$', i + 2);
      if (close === -1) throw new Error(`unterminated dollar quote starting on line ${line}`);
      const consumed = sql.slice(i, close + 2);
      emit(consumed);
      line += (consumed.match(/\n/g) || []).length;
      i = close + 2;
      continue;
    }

    if (rest.startsWith('--')) {
      const next = skipLineComment(i);
      emit(sql.slice(i, next));
      i = next;
      continue;
    }

    if (rest.startsWith("/*")) {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) throw new Error(`unterminated block comment on line ${line}`);
      const consumed = sql.slice(i, close + 2);
      emit(consumed);
      line += (consumed.match(/\n/g) || []).length;
      i = close + 2;
      continue;
    }

    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      if (j >= sql.length) throw new Error(`unterminated ${quote} quote on line ${line}`);
      emit(sql.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    if (sql[i] === ';') {
      if (current.trim()) out.push({ text: current.trim(), line: startLine });
      current = '';
      started = false;
      i += 1;
      continue;
    }

    if (sql[i] === '\n') line += 1;
    emit(sql[i]);
    i += 1;
  }

  if (current.trim()) out.push({ text: current.trim(), line: startLine });
  return out;
}

const failures = [];
const all = [];
let statements = 0;

function describe(err) {
  const message = err && err.message ? err.message : String(err);
  if (!err || typeof err.cursor !== 'number') return message;
  return `${message} (near "${String(err.cursor)}")`;
}

function checkPlpgsql(statement) {
  const body = /\$\$([\s\S]*?)\$\$/.exec(statement.text);
  if (!body) return;
  if (!/language\s+plpgsql/i.test(statement.text)) return;

  // The probe has to reproduce the declared return shape: a RETURNS TABLE or
  // RETURNS SETOF body may use RETURN QUERY, which plpgsql rejects in a scalar
  // function, so collapsing it to void would report a bug that is not there.
  let shape = 'void';
  if (/returns\s+table\s*\(/i.test(statement.text)) shape = 'setof record';
  else {
    const setof = /returns\s+setof\s+([a-zA-Z_.]+)/i.exec(statement.text);
    const plain = /returns\s+([a-zA-Z_.\[\]]+)/i.exec(statement.text);
    if (setof) shape = `setof ${setof[1]}`;
    else if (plain) shape = plain[1];
  }

  const wrapper = `create function inchat_probe() returns ${shape} as $$${body[1]}$$ language plpgsql;`;

  try {
    parsePlPgSQLSync(wrapper);
  } catch (err) {
    failures.push(`${statement.file} line ${statement.line}: plpgsql body - ${describe(err)}`);
  }
}

/**
 * Rules the grammar cannot see. These are the four that Supabase's own guidance
 * calls out and that this schema had to be fixed for once already, so they are
 * enforced instead of remembered: a policy that re-reads the JWT per row, a
 * policy with no role clause (which then applies to every role including
 * anon), a definer function that inherits a mutable search_path, and a function
 * left open to the world by the default PUBLIC execute grant.
 */

// Comments describe the rules using the same words the rules look for, so they
// are removed before any pattern is matched.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

function uncachedUid(text) {
  return /auth\s*\.\s*uid\s*\(\s*\)/i.test(
    stripComments(text).replace(/\(\s*select\s+auth\.uid\s*\(\s*\)\s*\)/gi, ' '),
  );
}

const CREATE_POLICY = /^\s*create\s+(?:or\s+replace\s+)?policy\b/i;
const CREATE_FUNCTION = /^\s*create\s+(?:or\s+replace\s+)?function\b/i;

// `(p_limit integer default 30, p_avatar text default null)` -> `integer,text`
function paramTypes(list) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  return parts
    .map((part) => {
      const words = part
        .split(/\bdefault\b/i)[0]
        .trim()
        .split(/\s+/)
        .filter((word) => !/^(in|out|inout|variadic|table)$/i.test(word));
      return words.length > 1 ? words[1] : words[0];
    })
    .join(',');
}

// `create function public.f(a uuid, b text) returns int` -> `public.f(uuid,text)`
function signatureOf(text) {
  const head = CREATE_FUNCTION.exec(text);
  if (!head) return null;
  const m = /^\s*create\s+(?:or\s+replace\s+)?function\s+([a-zA-Z_][\w.]*|"[^"]+")\s*\(/i.exec(text);
  if (!m) return null;
  let i = text.indexOf('(', m.index + m[0].length - 1);
  let depth = 0;
  let end = -1;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === '(') depth += 1;
    else if (text[j] === ')') {
      depth -= 1;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end === -1) return null;
  const name = m[1].includes('.') ? m[1] : `public.${m[1]}`;
  return `${name}(${paramTypes(text.slice(i + 1, end))})`;
}

function ruleIssues(statement) {
  const issues = [];
  // The leading comment of a statement is part of the chunk the splitter emits,
  // so the anchors have to be tested against the text with comments removed -
  // otherwise every documented function slips past these rules unnoticed.
  const text = stripComments(statement.text);

  if (CREATE_POLICY.test(text)) {
    if (uncachedUid(text)) {
      issues.push('policy calls auth.uid() per row; use (select auth.uid()) so it runs once');
    }
    if (!/\bto\s+(authenticated|anon|service_role|postgres)\b/i.test(stripComments(text))) {
      issues.push('policy has no TO clause, so it applies to every role including anon');
    }
  }

  if (CREATE_FUNCTION.test(text)) {
    if (!/\bset\s+search_path\s*=/i.test(stripComments(text))) {
      issues.push('function does not pin search_path');
    }
    // A plpgsql `me uuid := auth.uid()` runs once per call by construction; in a
    // plain SQL function the same call is repeated for every row the plan visits.
    if (/\blanguage\s+sql\b/i.test(text) && uncachedUid(text)) {
      issues.push('SQL function calls auth.uid() per row; use (select auth.uid())');
    }
  }

  return issues;
}

function checkCorpus(all) {
  const corpus = stripComments(all.map((s) => s.text).join('\n'));

  for (const statement of all) {
    for (const issue of ruleIssues(statement)) {
      failures.push(`${statement.file} line ${statement.line}: ${issue}`);
    }
  }

  // Privileges are declared by signature, so an unlisted function keeps the
  // default PUBLIC execute grant and any role can call it.
  const signatures = new Set();
  for (const statement of all) {
    const text = stripComments(statement.text);
    if (!CREATE_FUNCTION.test(text)) continue;
    const sig = signatureOf(text);
    if (!sig) {
      failures.push(`${statement.file} line ${statement.line}: cannot read the function signature`);
      continue;
    }
    signatures.add(sig);
    if (!corpus.includes(sig)) {
      failures.push(`${statement.file} line ${statement.line}: ${sig} is not in the privilege array`);
    }
  }

  return signatures.size;
}

function selfTest() {
  const cases = [
    {
      name: 'bare auth.uid() in a policy',
      text: 'create policy p on t for select to authenticated using (auth.uid() = id);',
      expect: 1
    },
    {
      name: 'cached auth.uid() in a policy',
      text: 'create policy p on t for select to authenticated using ((select auth.uid()) = id);',
      expect: 0
    },
    {
      name: 'policy without a TO clause',
      text: 'create policy p on t for select using (true);',
      expect: 1
    },
    {
      name: 'function without a search_path pin',
      text: "create or replace function public.f(a uuid) returns int language sql security definer as $$ select 1 $$;",
      expect: 1
    },
    {
      name: 'SQL function calling auth.uid() per row',
      text: 'create or replace function public.g() returns int language sql set search_path = public as $$ select case when auth.uid() is null then 0 else 1 end $$;',
      expect: 1
    },
    {
      // The bug this file shipped with once: a documented statement starts with
      // a comment, and an anchor that only looks at the raw text lets it through.
      name: 'function hidden behind its own comment',
      text: '-- Keeps the list ordered.\ncreate or replace function public.h(a uuid) returns int language sql as $$ select 1 $$;',
      expect: 1
    }
  ];

  const problems = [];

  for (const test of cases) {
    const found = ruleIssues({ text: test.text }).length;
    if ((found > 0 ? 1 : 0) !== test.expect) {
      problems.push(`${test.name}: expected ${test.expect === 1 ? 'a finding' : 'silence'}, got ${found}`);
    }
  }

  // The privilege check is only as good as the signature parser, so the parser
  // itself is pinned against the shapes the migrations actually use.
  const shapes = [
    ['create or replace function public.mark_messages_seen(p_conversation_id uuid)\nreturns integer language plpgsql as $$ begin return 0; end $$;', 'public.mark_messages_seen(uuid)'],
    ['create or replace function public.list_my_conversations(\n  p_limit integer default 30,\n  p_before_sort_at timestamptz default null,\n  p_before_id uuid default null\n)\nreturns table (id uuid) language sql as $$ select null $$;', 'public.list_my_conversations(integer,timestamptz,uuid)'],
    ['create or replace function public.send_message(\n  p_conversation_id uuid,\n  p_body text default \'\',\n  p_payload jsonb default \'{}\'::jsonb\n)\nreturns boolean language sql as $$ select true $$;', 'public.send_message(uuid,text,jsonb)'],
    ['create or replace function public.private_set_updated_at()\nreturns trigger language plpgsql as $$ begin return new; end $$;', 'public.private_set_updated_at()'],
    ['create or replace function public.private_pair_key(a uuid, b uuid)\nreturns text language sql immutable as $$ select 1 $$;', 'public.private_pair_key(uuid,uuid)']
  ];

  for (const [text, want] of shapes) {
    const got = signatureOf(text);
    if (got !== want) problems.push(`signature parser: expected ${want}, got ${got}`);
  }

  if (problems.length) {
    console.error(`rule self-test failed (${problems.length} problem(s)):`);
    for (const line of problems) console.error('  ' + line);
    process.exitCode = 1;
    return;
  }

  console.log(`ok - ${cases.length} rule cases and ${shapes.length} signature cases behave as intended`);
}

async function main() {
  if (flags.has('--self-test')) {
    selfTest();
    return;
  }

  await loadModule();
  for (const dir of migrationDirs) {
    for (const file of filesIn(dir)) {
      const sql = fs.readFileSync(file, 'utf8');
      const rel = path.relative(root, file);

      let parsed;
      try {
        parsed = splitStatements(sql);
      } catch (err) {
        failures.push(`${rel}: cannot split - ${err.message}`);
        continue;
      }

      for (const statement of parsed) {
        statements += 1;
        const located = { ...statement, file: rel };

        try {
          parseSync(statement.text);
        } catch (err) {
          failures.push(`${rel} line ${statement.line}: sql - ${describe(err)}`);
          continue;
        }

        checkPlpgsql(located);
        all.push(located);
      }
    }
  }

  const functions = checkCorpus(all);

  if (failures.length) {
    console.error(`${failures.length} problem(s) across ${statements} statement(s):`);
    for (const line of failures) console.error('  ' + line);
    // exitCode rather than exit(): the embedded parser keeps a libuv handle
    // open, and forcing the process down mid-close aborts on an assertion
    // instead of returning the code CI needs to read.
    process.exitCode = 1;
    return;
  }

  console.log(
    `ok - ${statements} statement(s) parse with the PostgreSQL grammar, ${functions} function(s) rule-checked`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
