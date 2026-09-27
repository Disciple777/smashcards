#!/usr/bin/env node
/**
 * Goalstruck <-> a markdown file in a project folder.
 *
 * The point of this is not markdown. It is that an agent working in a repo can
 * read what needs doing and tick it off without anyone opening a browser: the
 * file is the interface, and this script is the only thing that knows there is
 * an API behind it.
 *
 *   node goalstruck.mjs login              once per machine -- stores a token
 *   node goalstruck.mjs lists              this account's lists, and their ids
 *   node goalstruck.mjs link <list-id>     writes .goalstruck.json here
 *   node goalstruck.mjs pull               what is left to do -> file
 *   node goalstruck.mjs pull --marked      only what is marked as current
 *   node goalstruck.mjs pull --all         everything, done Bits included
 *   node goalstruck.mjs push               file  -> list  (ticks, unticks, adds)
 *   node goalstruck.mjs status             what push would do, without doing it
 *   node goalstruck.mjs add <text>...      add Bits without touching the file
 *   node goalstruck.mjs guide              rewrite the agent instructions only
 *   node goalstruck.mjs done <id|text>...  tick one Bit by id or title
 *
 * HOW IT REACHES ANYBODY ELSE
 *
 * `npm run build` copies this file into `dist/`, so it deploys with the app and
 * any user can fetch it from the site they already log in to:
 *
 *     https://guatermelon.com/goalstruck/goalstruck.mjs
 *
 * That is the whole distribution story, and it is why there are no
 * dependencies and no build step -- one file that runs where it lands. It is
 * deliberately not on npm: publishing means a package name, a release process
 * and a version to keep in step with an API it is shipped beside anyway.
 *
 * WHY THE FILE IS THE SOURCE OF TRUTH FOR TICKS, AND THE LIST FOR EVERYTHING ELSE
 *
 * A two-way sync needs a conflict rule, and the honest one here is narrow.
 * `push` only ever changes three things: a checkbox that was ticked in the
 * file, a checkbox that was unticked, and a line that has no id yet. Titles,
 * order, nesting, priorities and anything else are read from the list and
 * rewritten into the file by `pull` -- they are never read back out of it. So
 * editing prose in the file is safe in the sense that it will be discarded, and
 * never in the sense that it will be applied.
 *
 * That is deliberate. The alternative -- a real diff over a tree -- has to
 * guess whether a changed line is a rename or a delete plus an add, and getting
 * that wrong deletes somebody's work. Ticking a box cannot.
 *
 * WHY IDS ARE IN HTML COMMENTS
 *
 * A line has to be matchable after it has been edited, and titles are not
 * stable enough: two "Fix the tests" in one file, or one of them reworded, and
 * a title match silently ticks the wrong Bit. So each line carries its Bit id
 * in a trailing `<!--gs:123-->`, which every markdown renderer hides and every
 * text editor shows. A line without one is new, which is exactly what you want
 * when you type a line by hand.
 *
 * NO DEPENDENCIES
 *
 * Node 18+, `fetch` and `node:` builtins only. This ends up copied into other
 * repos, and an npm install is a reason not to bother.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative as relativePath, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, argv, exit } from 'node:process'

const PROJECT_CONFIG = '.goalstruck.json'
const CREDENTIALS = join(homedir(), '.goalstruck', 'credentials.json')
const DEFAULT_API = 'https://guatermelon.com/goalstruck/backend/public'
const DEFAULT_FILE = 'GOALSTRUCK.md'
const DEFAULT_GUIDE = 'GOALSTRUCK-COMMANDS.md'

/** `- [ ] Title <!--gs:123-->`, at any indent, with the id optional. */
const TASK_LINE = /^(\s*)[-*]\s+\[( |x|X)\]\s+(.*?)\s*(?:<!--\s*gs:(\d+)\s*-->)?\s*$/

/**
 * Which pull a file came from, written into the file itself.
 *
 * `push` and `done` re-pull afterwards, and have to reproduce the same file:
 * without this a marked-only file would come back as the whole list, and a
 * file pulled with --all would lose its done Bits on the first tick. A plain
 * `pull` does not read it -- what you type is what you get -- so the marker
 * only ever carries a file's shape through a sync, never across commands.
 */
const MODE_MARKER = /<!--\s*goalstruck:([a-z,]+)\s*-->/

function readMode(text) {
  const flags = MODE_MARKER.exec(text)?.[1]?.split(',') ?? []

  return { marked: flags.includes('marked'), done: flags.includes('all') }
}

function modeFromArgs(args) {
  return { marked: args.includes('--marked'), done: args.includes('--all') }
}

/* ---------------------------------------------------------------------------
 * Config and credentials
 *
 * Split on purpose. The project config describes *this repo* and is meant to be
 * committed; the token is per machine and must never be, which is why it lives
 * in the home directory rather than in a gitignored file next to it that
 * somebody will eventually commit anyway.
 * ------------------------------------------------------------------------- */

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

async function projectConfig() {
  const path = resolve(PROJECT_CONFIG)
  const config = await readJson(path)

  if (config === null) {
    fail(
      `No ${PROJECT_CONFIG} in ${process.cwd()}\n\n` +
        `  node goalstruck.mjs lists          to see your lists\n` +
        `  node goalstruck.mjs link <list-id> to connect this folder to one`,
    )
  }

  return { api: DEFAULT_API, file: DEFAULT_FILE, guide: DEFAULT_GUIDE, ...config }
}

async function token() {
  // The environment wins, so CI and a throwaway shell never have to write a
  // file, and so a wrong stored token can be stepped around in one command.
  if (process.env.GOALSTRUCK_TOKEN) {
    return process.env.GOALSTRUCK_TOKEN
  }

  const stored = await readJson(CREDENTIALS)

  if (stored?.token) {
    return stored.token
  }

  fail('Not signed in. Run: node goalstruck.mjs login')
}

/* ---------------------------------------------------------------------------
 * API
 * ------------------------------------------------------------------------- */

async function api(config, method, path, { body, query, auth = true } = {}) {
  const url = new URL(config.api.replace(/\/$/, '') + path)

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }

  const headers = { Accept: 'application/json' }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  if (auth) {
    headers.Authorization = `Bearer ${await token()}`
  }

  let response

  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    fail(`Could not reach ${url.origin}: ${error.message}`)
  }

  const text = await response.text()
  let payload = null

  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    // A non-JSON body means PHP emitted a warning or an error page. The status
    // is still the useful signal.
  }

  if (!response.ok) {
    // Only a *stored* token can have gone stale. During login there is no token
    // yet, and telling somebody who mistyped their password to sign in again --
    // which is what they were doing -- is the least helpful thing available.
    if (response.status === 401 && auth) {
      fail('That token is not valid any more. Run: node goalstruck.mjs login')
    }

    fail(payload?.message ?? `${method} ${path} failed (${response.status})`)
  }

  return payload
}

/**
 * The one list this folder is linked to.
 *
 * There is no "fetch one list" endpoint, so this reads the overview and picks.
 * Deliberately not adding one: the overview is a handful of rows, the endpoint
 * already exists and is already tested, and a second way to read a list is a
 * second thing to keep true.
 */
async function fetchList(config) {
  const payload = await api(config, 'GET', '/api/lists', {
    // Descriptions are opt-in on the server: the app never shows one in a row,
    // but here they are the half of a task an agent actually needs to read. A
    // server older than that ignores the flag, and the file simply has none.
    query: { include_completed: 1, include_notes: 1 },
  })

  const found = (payload.lists ?? []).find((list) => Number(list.id) === Number(config.list))

  if (found === undefined) {
    fail(
      `List ${config.list} is not in this account any more.\n` +
        `Run \`node goalstruck.mjs lists\` and re-link with \`... link <list-id>\`.`,
    )
  }

  return found
}

/* ---------------------------------------------------------------------------
 * Markdown
 * ------------------------------------------------------------------------- */

/**
 * One line per Bit, in the list's own order and nesting.
 *
 * The shapes match `src/lib/checklistText.ts`, because the same file is going
 * to be pasted into a chat or an issue and it should look like the app's own
 * copy output when it lands there.
 */
/** Something to do, as opposed to a note, heading or toggle arranging it. */
function isTask(item) {
  return !['note', 'heading', 'toggle'].includes(item.bit_type)
}

function toMarkdown(list, { marked = false, done = false } = {}) {
  const lines = []

  /**
   * Whether a Bit earns its own place in the file, before its parents are
   * considered: open (unless --all), and marked (if --marked).
   *
   * Notes and headings are never "done" in a way that matters, so the done
   * filter leaves them alone -- a document's prose and its section titles do
   * not vanish because the tasks under them were ticked.
   *
   * A toggle is different: it exists to hold things, so it is kept for what it
   * holds and not for itself. Once everything inside is done it is an empty
   * fold, and a to-do file full of those reads as work that is not there. With
   * --all it shows regardless, because --all means everything.
   */
  function wanted(item) {
    if (item.bit_type === 'toggle') {
      return done && !marked
    }

    const open = done || !isTask(item) || item.status !== 'completed'

    return open && (!marked || item.is_marked === true)
  }

  /**
   * A Bit stays if it is wanted, or holds something that is. A finished parent
   * with open subtasks stays, ticked, because the subtasks alone would lose
   * what they are part of -- and "which project is this for" is exactly what
   * an agent needs to know.
   */
  function keep(item) {
    return wanted(item) || (item.children ?? []).some(keep)
  }

  /**
   * A Bit's description, as a quote under its line.
   *
   * Every line is prefixed with `>`, which is also what keeps this safe: a
   * description that happens to contain `- [ ] something` can never be read
   * back by `push` as a task, because the regex needs the dash first.
   */
  function describe(item, pad) {
    const text = (item.description ?? '').trim()

    if (text === '') {
      return
    }

    for (const line of text.split(/\r?\n/)) {
      lines.push(line.trim() === '' ? `${pad}  >` : `${pad}  > ${line.trimEnd()}`)
    }
  }

  function walk(items, depth) {
    for (const item of items) {
      if (!keep(item)) {
        continue
      }

      const pad = '  '.repeat(depth)
      const id = `<!--gs:${item.id}-->`

      if (item.bit_type === 'heading') {
        lines.push('', `${'#'.repeat(Math.min(depth + 2, 4))} ${item.title} ${id}`, '')
        describe(item, '')
      } else if (item.bit_type === 'note') {
        lines.push(`${pad}${item.title} ${id}`)
        describe(item, pad)
      } else if (item.bit_type === 'toggle') {
        lines.push(`${pad}**${item.title}** ${id}`)
        describe(item, pad)
      } else {
        lines.push(`${pad}- [${item.status === 'completed' ? 'x' : ' '}] ${item.title} ${id}`)
        describe(item, pad)
      }

      walk(item.children ?? [], depth + 1)
    }
  }

  walk(list.items ?? [], 0)

  const flags = [marked ? 'marked' : null, done ? 'all' : null].filter(Boolean)
  const shows = marked
    ? done
      ? 'Only the Bits marked as current, done ones included, and whatever they sit inside.'
      : 'Only the open Bits marked as current, and whatever they sit inside.'
    : done
      ? 'Every Bit in the list, done ones included.'
      : 'What is left to do. Done Bits are left out -- pull --all includes them.'

  const header = [
    ...(flags.length > 0 ? [`<!-- goalstruck:${flags.join(',')} -->`] : []),
    `<!-- Synced from Goalstruck. ${shows}`,
    '     Tick a box, then: node goalstruck.mjs push',
    marked
      ? '     A line with no `gs:` comment becomes a new marked Bit when you push.'
      : '     A line with no `gs:` comment becomes a new Bit when you push.',
    '     Lines starting with > are descriptions, and are never read back.',
    '     Everything else here is rewritten by `node goalstruck.mjs pull`. -->',
  ]

  return [`# ${list.title}`, '', ...header, '', ...lines]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n'
}

/**
 * The commands, written next to the tasks they operate on.
 *
 * The task file tells an agent *what* to do. On its own it says nothing about
 * how to report back, so agents read it, do the work and then leave the list
 * exactly as they found it -- the ticking is the half that never happens. This
 * is the other half, and it is a separate file for two reasons: the task file
 * is rewritten from the server on every pull, so anything durable written into
 * it is lost, and a page of instructions at the top of a to-do list buries the
 * to-do list.
 *
 * Regenerated on every pull rather than written once, so it can never describe
 * a version of the CLI that is no longer the one sitting beside it. It is
 * therefore generated output: edit this function, not the file.
 */
function guideMarkdown(config, path) {
  const run = `node ${path}`

  return [
    `# Working with ${config.file}`,
    '',
    '<!-- Generated by `goalstruck pull`. Edits here are overwritten. -->',
    '',
    `\`${config.file}\` is a live view of a Goalstruck list (id ${config.list}). It is not a`,
    'scratch file: it is synced with an app the person you are working for has open.',
    '',
    '## Read it',
    '',
    `- \`- [ ]\` is open, \`- [x]\` is done. Nesting is real -- an indented line is a subtask.`,
    '- The `<!--gs:123-->` on each line is that Bit\'s id. Never invent, edit or reuse one.',
    '- Lines starting with `>` are descriptions. They are display only and are never read back.',
    '- A line with no `<!--gs:-->` is one nobody has synced yet.',
    '',
    '## Report what you did',
    '',
    'Tick the box in the file, then push. Both steps -- a tick that is never pushed',
    'changes nothing for anyone but you.',
    '',
    '```bash',
    `${run} status   # what a push would change, without changing it`,
    `${run} push     # send ticks, unticks and any new lines`,
    '```',
    '',
    'Or tick without editing the file at all, by id or by enough of the title to',
    'match exactly one line:',
    '',
    '```bash',
    `${run} done 123`,
    `${run} done "the failing test"`,
    '```',
    '',
    '## Add work you have found',
    '',
    '`add` only ever creates. It cannot tick, untick or delete anything, which is',
    'what makes it safe to run without reading the list first.',
    '',
    '```bash',
    `${run} add "Fix the flaky login test" "Document the deploy step"`,
    `${run} add --priority high --marked "Restore the backup job"`,
    `${run} add --note "Blocked on the DNS change" "Move the staging domain"`,
    `${run} add -   # one Bit per line on stdin; leading bullets are stripped`,
    '```',
    '',
    'A new line typed straight into the file works too -- `push` creates a Bit for',
    'anything without an id -- but `add` does not need the file to be in sync first.',
    '',
    '## Refresh',
    '',
    '```bash',
    `${run} pull            # what is left to do`,
    `${run} pull --marked   # only what is marked as current`,
    `${run} pull --all      # everything, done Bits included`,
    '```',
    '',
    '`pull` rewrites the file from the server. Anything you typed and did not push',
    'is lost, so push before you pull.',
    '',
    '## What sync will and will not do',
    '',
    'Only three things travel from the file to the app: a box you ticked, a box you',
    'unticked, and a line with no id. Titles, order, nesting and priorities are read',
    'from the app and written into the file, never the other way round.',
    '',
    'So rewording a line here does **not** rename the Bit -- the next pull simply',
    'puts the old wording back. To change a title, tick the old Bit and `add` the new',
    'one, or do it in the app.',
    '',
  ].join('\n')
}

/** Every task line in the file, with whatever id it carries. */
function parseMarkdown(text) {
  const rows = []

  text.split(/\r?\n/).forEach((line, index) => {
    const match = TASK_LINE.exec(line)

    if (match === null) {
      return
    }

    const [, indent, box, title, id] = match

    if (title.trim() === '') {
      return
    }

    rows.push({
      line: index,
      indent: indent.length,
      checked: box.toLowerCase() === 'x',
      title: title.trim(),
      id: id === undefined ? null : Number(id),
    })
  })

  return rows
}

/** Every Bit in the list, flattened, so a row can be looked up by id. */
function flatten(list) {
  const found = new Map()

  function walk(items) {
    for (const item of items) {
      found.set(Number(item.id), item)
      walk(item.children ?? [])
    }
  }

  walk(list.items ?? [])

  return found
}

/**
 * What `push` would do.
 *
 * Split out from doing it so `status` and `push` cannot disagree about what
 * counts as a change -- the failure mode where a dry run says one thing and the
 * real one does another is worse than having no dry run.
 */
function plan(rows, byId) {
  const complete = []
  const reopen = []
  const create = []
  const missing = []

  for (const row of rows) {
    if (row.id === null) {
      create.push(row)
      continue
    }

    const bit = byId.get(row.id)

    if (bit === undefined) {
      // The Bit was deleted in the app, or the file came from another list.
      // Reported rather than recreated: recreating it would resurrect work
      // somebody deliberately threw away.
      missing.push(row)
      continue
    }

    const done = bit.status === 'completed'

    if (row.checked && !done) {
      complete.push({ row, bit })
    } else if (!row.checked && done) {
      reopen.push({ row, bit })
    }
  }

  return { complete, reopen, create, missing }
}

/* ---------------------------------------------------------------------------
 * Commands
 * ------------------------------------------------------------------------- */

const commands = {
  async login(...args) {
    // The API base is a flag, not a question. Almost everybody is on the one
    // hosted instance, and asking first meant the first thing this tool ever
    // said to a new user was a question only a self-hoster could answer.
    const flag = args.indexOf('--api')
    const base = flag === -1 ? DEFAULT_API : args[flag + 1]

    if (base === undefined) {
      fail('--api needs a URL after it.')
    }

    say(`Signing in to ${base}`)
    say('This is your Goalstruck account -- the same one you use in the browser.')

    const ask = await prompter()
    const email = await ask.line('Email: ')
    const password = await ask.secret('Password: ')

    ask.close()

    const session = await api({ api: base }, 'POST', '/api/auth/login', {
      body: { email, password },
      auth: false,
    })

    if (!session?.token) {
      fail('The server did not return a token.')
    }

    await mkdir(join(homedir(), '.goalstruck'), { recursive: true })
    await writeFile(CREDENTIALS, JSON.stringify({ api: base, token: session.token }, null, 2))

    say('')
    say(`Signed in. Token stored in ${CREDENTIALS}`)
    say('That file is your account -- keep it out of any repo.')
    say('')
    say('Next: node goalstruck.mjs lists')
  },

  async lists() {
    const stored = await readJson(CREDENTIALS, {})
    const config = { api: stored.api ?? DEFAULT_API }
    const sources = await api(config, 'GET', '/api/lanes/sources')

    if ((sources.lists ?? []).length === 0) {
      say('No lists in this account yet.')
      return
    }

    for (const list of sources.lists) {
      say(`${String(list.id).padStart(6)}  ${list.title}`)
    }
  },

  async link(listId, file) {
    if (listId === undefined) {
      fail('Which list? Run `node goalstruck.mjs lists` for the ids.')
    }

    const stored = await readJson(CREDENTIALS, {})
    const config = {
      api: stored.api ?? DEFAULT_API,
      list: Number(listId),
      file: file ?? DEFAULT_FILE,
    }

    // Fetched before writing, so linking to a list that does not exist fails
    // here rather than on the first pull in a week's time.
    const list = await fetchList(config)

    await writeFile(resolve(PROJECT_CONFIG), JSON.stringify(config, null, 2) + '\n')

    say(`Linked to "${list.title}" (${config.list}).`)
    say(`Wrote ${PROJECT_CONFIG}. Now: node goalstruck.mjs pull`)
  },

  async pull(...args) {
    const config = await projectConfig()
    const path = resolve(config.file)

    // What you type is what you get: `pull` is what is left, --marked narrows
    // it, --all adds the done Bits back. The one exception is `sync`, passed by
    // push and done, which reproduces whatever shape the file already had.
    let mode = modeFromArgs(args)

    if (args.includes('--keep-mode') && existsSync(path)) {
      mode = readMode(await readFile(path, 'utf8'))
    }

    const list = await fetchList(config)

    await writeFile(path, toMarkdown(list, mode))

    // The commands, beside the tasks. `guide: false` in .goalstruck.json turns
    // it off for a repo that would rather keep its own instructions -- opt-out
    // rather than opt-in, because the whole point is that an agent which was
    // never told this file exists still finds it next to the one it was given.
    if (config.guide !== false) {
      await writeFile(resolve(config.guide ?? DEFAULT_GUIDE), guideMarkdown(config, entryPath()))
    }

    // Tasks only. A note or a toggle is not "left to do", and counting them
    // told a list with nothing open that it still had two things waiting.
    const items = [...flatten(list).values()].filter(isTask)
    const open = items.filter((item) => item.status !== 'completed')
    const markedOpen = open.filter((item) => item.is_marked).length
    const doneCount = items.length - open.length

    say(
      mode.marked
        ? `${config.file}: ${markedOpen} marked, ${open.length} open, ${items.length} in the list.`
        : mode.done
          ? `${config.file}: ${items.length} Bits, ${doneCount} done.`
          : `${config.file}: ${open.length} left to do. ${doneCount} done not shown (pull --all).`,
    )
  },

  async status() {
    const config = await projectConfig()
    const { complete, reopen, create, missing } = await pending(config)

    if (complete.length + reopen.length + create.length === 0) {
      say(`${config.file} matches the list.`)
    }

    for (const { bit } of complete) say(`  tick    ${bit.title}`)
    for (const { bit } of reopen) say(`  untick  ${bit.title}`)
    for (const row of create) say(`  add     ${row.title}`)
    for (const row of missing) say(`  gone    ${row.title} (Bit ${row.id} no longer exists)`)
  },

  async push() {
    const config = await projectConfig()
    const { complete, reopen, create, missing, marked } = await pending(config)

    for (const { bit } of complete) {
      await api(config, 'PATCH', '/api/bits/state', {
        body: { bit_id: bit.id, status: 'completed' },
      })
      say(`ticked   ${bit.title}`)
    }

    for (const { bit } of reopen) {
      await api(config, 'PATCH', '/api/bits/state', {
        body: { bit_id: bit.id, status: 'active' },
      })
      say(`unticked ${bit.title}`)
    }

    for (const row of create) {
      const created = await api(config, 'POST', '/api/lists/items', {
        body: { list_bit_id: config.list, title: row.title },
      })

      // In a marked-only file a new line is a new *marked* Bit. Otherwise the
      // pull that follows would drop it from the very file it was typed into.
      if (marked) {
        await api(config, 'PATCH', '/api/bits/marked', {
          body: { bit_id: created.bit_id, marked: true },
        })
      }

      say(`added    ${row.title} (${created.bit_id})${marked ? ', marked' : ''}`)
    }

    for (const row of missing) {
      warn(`skipped  ${row.title} -- Bit ${row.id} no longer exists`)
    }

    if (complete.length + reopen.length + create.length === 0) {
      say('Nothing to push.')
      return
    }

    // Pulled straight back so the file carries the ids of anything just
    // created. Without this, a second push would create them all over again.
    await commands.pull('--keep-mode')
  },

  /**
   * Bits straight in, without going through the file.
   *
   * `push` can already create a line that has no id, but it needs the file to
   * be in the shape `pull` left it, and it rewrites the whole thing afterwards.
   * That is the wrong instrument for "write these three things down": an agent
   * that has just found four TODOs in a repo should be able to say so in one
   * command without first reconciling a document it may never have read.
   *
   * So `add` only ever creates. It never ticks, never unticks and never
   * deletes -- which is what makes it safe to hand to an agent, and why it is
   * a separate command rather than a flag on `push`.
   */
  async add(...args) {
    const flags = {
      marked: args.includes('--marked'),
      list: value(args, '--list'),
      priority: value(args, '--priority'),
      note: value(args, '--note'),
    }

    const priority = flags.priority === undefined ? 0 : PRIORITIES[flags.priority.toLowerCase()]

    if (priority === undefined) {
      fail('--priority takes none, low, medium or high.')
    }

    // Titles are whatever is left once the flags and their values are gone.
    // Deliberately no `#tag` or `!high` shorthand: the app strips those, and a
    // half-implementation here would quietly eat part of a line that an agent
    // piped in verbatim. Flags say the same thing and cannot be typed by
    // accident.
    const skip = new Set()

    args.forEach((arg, index) => {
      if (['--list', '--priority', '--note'].includes(arg)) {
        skip.add(index).add(index + 1)
      } else if (arg === '--marked') {
        skip.add(index)
      }
    })

    let titles = args.filter((_, index) => !skip.has(index))

    // `-` reads one Bit per line from stdin, which is how a list that was
    // generated rather than typed gets in: `grep -h TODO -r . | goalstruck add -`.
    if (titles.length === 1 && titles[0] === '-') {
      let text = ''

      for await (const chunk of stdin) {
        text += chunk
      }

      titles = text
        .split(/\r?\n/)
        // A leading bullet or checkbox is stripped, because the most likely
        // thing on the other end of that pipe is a markdown list.
        .map((line) => line.replace(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?/, '').trim())
        .filter((line) => line !== '')
    }

    if (titles.length === 0) {
      fail(
        'What should I add?\n\n' +
          '  node goalstruck.mjs add "Fix the build" "Write the changelog"\n' +
          '  node goalstruck.mjs add - < todos.txt\n\n' +
          '  --list <id>        add to a list other than this folder\'s\n' +
          '  --priority <low|medium|high>\n' +
          '  --marked           mark each one as current\n' +
          '  --note <text>      a description, for a single Bit',
      )
    }

    if (flags.note !== undefined && titles.length > 1) {
      fail('--note describes one Bit. Add them one at a time to give each its own.')
    }

    // The linked list unless told otherwise. `--list` is what lets this run
    // from a folder that was never linked at all, which an agent asked to
    // "put these in Goalstruck" often is.
    const config =
      flags.list === undefined
        ? await projectConfig()
        : { ...(await readJson(CREDENTIALS, {})), api: DEFAULT_API, list: Number(flags.list) }

    if (!Number.isFinite(Number(config.list))) {
      fail('--list takes a list id. Run `node goalstruck.mjs lists` to see them.')
    }

    for (const title of titles) {
      const created = await api(config, 'POST', '/api/lists/items', {
        body: { list_bit_id: Number(config.list), title, priority },
      })

      if (flags.marked) {
        await api(config, 'PATCH', '/api/bits/marked', {
          body: { bit_id: created.bit_id, marked: true },
        })
      }

      if (flags.note !== undefined) {
        await api(config, 'PATCH', '/api/bits/note', {
          body: { bit_id: created.bit_id, body: flags.note },
        })
      }

      say(`added    ${title} (${created.bit_id})${flags.marked ? ', marked' : ''}`)
    }

    // Only when the file is looking at the list that just changed. Pulling
    // after an `--list` add would rewrite this folder's file with a list it has
    // nothing to do with.
    if (flags.list === undefined && existsSync(resolve(config.file))) {
      await commands.pull('--keep-mode')
    }
  },

  /**
   * The instructions on their own, without a round trip.
   *
   * `pull` writes this file too, so this command exists for the case where the
   * tasks are already current and only the instructions are missing -- somebody
   * deleted them, or the folder was linked before this existed.
   */
  async guide() {
    const config = await projectConfig()

    if (config.guide === false) {
      fail(`Instructions are turned off for this folder. Remove "guide": false from ${PROJECT_CONFIG}.`)
    }

    const path = config.guide ?? DEFAULT_GUIDE

    await writeFile(resolve(path), guideMarkdown(config, entryPath()))

    say(`Wrote ${path}. Point your agent at it.`)
  },

  async done(...terms) {
    if (terms.length === 0) {
      fail('Which Bit? An id, or enough of its title to match one line.')
    }

    const config = await projectConfig()
    const list = await fetchList(config)
    const items = [...flatten(list).values()]

    for (const term of terms) {
      const matches = /^\d+$/.test(term)
        ? items.filter((item) => Number(item.id) === Number(term))
        : items.filter((item) => item.title.toLowerCase().includes(term.toLowerCase()))

      if (matches.length === 0) {
        warn(`no match: ${term}`)
        continue
      }

      if (matches.length > 1) {
        // Refused rather than guessed. "Tick the first thing that matched" is
        // how the wrong task gets closed.
        warn(`ambiguous: ${term}`)
        for (const item of matches) warn(`    ${item.id}  ${item.title}`)
        continue
      }

      await api(config, 'PATCH', '/api/bits/state', {
        body: { bit_id: matches[0].id, status: 'completed' },
      })
      say(`ticked   ${matches[0].title}`)
    }

    await commands.pull('--keep-mode')
  },
}

/** The value after a flag, or undefined when the flag is not there. */
function value(args, flag) {
  const at = args.indexOf(flag)

  if (at === -1) {
    return undefined
  }

  const next = args[at + 1]

  if (next === undefined || next.startsWith('--')) {
    fail(`${flag} needs a value after it.`)
  }

  return next
}

const PRIORITIES = { none: 0, low: 1, medium: 2, med: 2, high: 3 }

/**
 * How to invoke this script, as the person running it would type it.
 *
 * Read from argv rather than hardcoded, because the guide is meant to be
 * copy-pasteable and this file gets installed under several names -- alongside
 * the app as `goalstruck.mjs`, vendored into a repo, or on PATH as a shim.
 */
function entryPath() {
  const invoked = argv[1]

  if (invoked === undefined) {
    return 'goalstruck.mjs'
  }

  const relative = relativePath(process.cwd(), invoked)

  return relative.startsWith('..') ? invoked : relative
}

async function pending(config) {
  const path = resolve(config.file)

  if (!existsSync(path)) {
    fail(`${config.file} is not here yet. Run: node goalstruck.mjs pull`)
  }

  const [text, list] = await Promise.all([readFile(path, 'utf8'), fetchList(config)])

  return { ...plan(parseMarkdown(text), flatten(list)), marked: readMode(text).marked }
}

/* ------------------------------------------------------------------------- */

/**
 * Asks for a line, and for a line that must not be echoed.
 *
 * Two implementations because there are two situations, and the obvious single
 * one is broken in both. `readline/promises` settles only the *first*
 * `question()` when stdin is a pipe -- every later one hangs until the process
 * gives up -- so a scripted `login` could never get past the email. And
 * readline has no way to hide what is typed, so an interactive password would
 * sit in the scrollback and the shell history of whoever ran it.
 *
 * So: readline plus raw mode when there is a terminal, and when there is not,
 * the input is read to the end and handed out a line at a time. Raw mode is
 * used directly rather than through readline's private `_writeToOutput`, which
 * is what most snippets reach for and is not a surface to depend on.
 */
async function prompter() {
  if (stdin.isTTY) {
    const rl = createInterface({ input: stdin, output: stdout })

    return {
      line: async (prompt) => (await rl.question(prompt)).trim(),
      secret: (prompt) => hidden(prompt),
      close: () => rl.close(),
    }
  }

  let text = ''

  for await (const chunk of stdin) {
    text += chunk
  }

  const lines = text.split(/\r?\n/)

  return {
    line: async (prompt) => {
      const value = lines.shift() ?? ''

      // Echoed, because a piped run has no other record of what it answered.
      stdout.write(prompt + value + '\n')

      return value.trim()
    },
    secret: async (prompt) => {
      const value = lines.shift() ?? ''

      stdout.write(prompt + '\n')

      return value
    },
    close: () => {},
  }
}

/** One line from a real terminal, with nothing drawn as it is typed. */
async function hidden(prompt) {
  stdout.write(prompt)

  const wasRaw = stdin.isRaw

  stdin.setRawMode(true)
  stdin.resume()

  let value = ''

  try {
    for await (const chunk of stdin) {
      let done = false

      for (const code of chunk) {
        if (code === 3) {
          // Ctrl-C. The finally puts the terminal back before this exits -- a
          // shell left in raw mode after a quit is a broken shell.
          stdout.write('\n')
          exit(130)
        }

        if (code === 13 || code === 10) {
          done = true
          break
        }

        if (code === 127 || code === 8) {
          value = value.slice(0, -1)
          continue
        }

        if (code >= 32) {
          value += String.fromCharCode(code)
        }
      }

      if (done) {
        break
      }
    }
  } finally {
    stdin.setRawMode(wasRaw)
    stdin.pause()
  }

  stdout.write('\n')

  return value
}

function say(message) {
  stdout.write(message + '\n')
}

function warn(message) {
  stdout.write(message + '\n')
}

function fail(message) {
  stdout.write(message + '\n')
  exit(1)
}

const [name, ...args] = argv.slice(2)
const command = commands[name ?? '']

if (command === undefined) {
  say(
    [
      'node goalstruck.mjs <command>',
      '',
      '  login [--api <url>]    sign in once, per machine',
      '  lists                  your lists and their ids',
      '  link <list-id> [file]  connect this folder to a list',
      '  pull                   what is left to do -> file',
      '  pull --marked          only what is marked as current',
      '  pull --all             everything, done Bits included',
      '  push                   file -> list (ticks, unticks, adds)',
      '  status                 what push would do',
      '  add <text>...          add Bits, without touching the file',
      '  add - < file           one Bit per line from stdin',
      '  guide                  rewrite the agent instructions',
      '  done <id|text>...      tick one Bit',
      '',
      'Start with login, then lists, then link.',
    ].join('\n'),
  )
  exit(name === undefined ? 0 : 1)
}

await command(...args)
