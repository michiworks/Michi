import { Clock, Layers, ListTree, MessageSquare, Network, FileText, PanelLeft, Plus, Search, Split, Quote, MessageSquareText, Sparkle, File, Check, ChevronDown, X, ArrowUp, Square, AtSign } from 'lucide-react'
// Direct modules, not the kit barrel: each part brings its own CSS, and the
// barrel would bundle every part's (phones and all) into the landing page.
import { Stage } from '../kit/stage'
import { Window } from '../kit/window'
import { Collapse } from '../kit/motion/Collapse'
import { Stream } from '../kit/motion/Stream'
import type { Act } from '../kit/act'
import type { Layout } from '../kit/looks'
import './look.css'
import './michi.css'

/*
  Michi, the landing page hero. Pilot of the stageshow skill.

  PLAN
  - Medium: an animation that plays once when in view and holds its payoff
    (the page's own take plays once per session too). Poster = the payoff.
  - Place: a wide hero under the two-column headline band of a near-white page
    (#fbfbfc), shown about 1100 to 1280 wide. Design 1200 x 680 at 1:1; the
    stage is transparent (the page is the ground: no plate). Layout: wide hero
    (examples/linear): Michi's window inset 40 at the top and sides, running
    off the bottom just under the composers. Phone column: a compact design
    at 358.
  - Focal object: the phrase "task runner role" in the agent's answer, then
    the branch pane that opens from it.
  - Action: select the phrase, Branch, type the question, Branch again. The
    branch pane arrives beside the main pane, which slides over to make room;
    both panes answer at once (the main thread keeps going: a follow-up is
    sent there while the branch works).
  - Payoff: two panes side by side, the branch answered, the phrase in the
    main answer underlined as a branch anchor, the new thread in the sidebar.
  - Left out: Michi's top-row breadcrumb and New chat button, the sidebar
    footer, the second and third threads' names (bars), the second half of
    the main thread's history, the Map, every other branch.

  Real strings (the story): the first question, the answer that holds the
  phrase, the branch question and answer, the follow-up and its answer, the
  thread and project names the story touches. Everything else is Bar.

  Look: Michi's Slate tokens with the violet accent override (look.css),
  Geist and Geist Mono, lucide icons at 1.5 to 1.8 stroke as the app uses.
*/

const Q1 = 'Tokyo’s deploy failed with “Invalid principal”. Can you check?'
const LEAD = 'Two things to check:'
const B1 = 'One referenced identity cannot be resolved.'
const ITEM1_REST = ' The policy lists 11 developer accounts and a '
const PHRASE = 'task runner role'
const ITEM1 = B1 + ITEM1_REST + PHRASE + '.'
const P_START = (B1 + ITEM1_REST).length
const B2 = 'Tokyo is a first-time deployment.'
const ITEM2_REST = ' Other regions may already have what Tokyo is missing.'

const BQ = 'Who creates the task runner role?'
const BA: Seg[] = [
  { t: 'The bootstrap stack creates it.', b: true },
  { t: 'Tokyo applies the policy before bootstrap runs, so the role doesn’t exist yet when the policy checks it.' },
]
const Q2 = 'Prepare the post-deploy checks.'
const A2: Seg[] = [{ t: 'After the fix: confirm the Tokyo deploy completes, then run a health check before opening traffic.' }]

type Seg = { t: string; b?: boolean }
const words = (segs: Seg[]) => segs.reduce((n, s) => n + s.t.split(' ').length, 0)
const BA_N = words(BA)
const A2_N = words(A2)

type S = {
  /** characters of the phrase under the selection */
  sel: number
  hl: 'none' | 'select' | 'mark' | 'anchor'
  pop: 'hidden' | 'bar' | 'composer'
  bq: string
  pressBranch: boolean
  forked: boolean
  tool: 'hidden' | 'run' | 'done'
  bWords: number
  bLive: boolean
  q2: string
  sent2: boolean
  mPhase: 'idle' | 'thinking' | 'answer'
  mWords: number
  mLive: boolean
}

const initial: S = {
  sel: 0, hl: 'none', pop: 'hidden', bq: '', pressBranch: false, forked: false,
  tool: 'hidden', bWords: 0, bLive: false, q2: '', sent2: false, mPhase: 'idle', mWords: 0, mLive: false,
}
const poster: S = {
  ...initial, sel: PHRASE.length, hl: 'anchor', bq: BQ, forked: true, tool: 'done', bWords: BA_N,
  sent2: true, mPhase: 'answer', mWords: A2_N,
}

const REST = { wide: { x: 1010, y: 210 }, compact: { x: 304, y: 92 } }

async function script(a: Act<S>) {
  const compact = a.layout === 'compact'
  await a.wait(900)

  // 1. Select the phrase, left to right, under the I-beam
  a.mark('select')
  const p = a.rect('phrase')
  const y = p.y + p.height / 2
  await a.move({ x: p.x + 1, y })
  await a.wait(200)
  a.put({ hl: 'select' })
  await a.drag({ x: p.x + p.width + 1, y }, (at) => {
    a.put({ sel: Math.max(0, Math.min(PHRASE.length, a.caret('item1', at) - P_START)) })
  }, { duration: 750 })
  a.put({ sel: PHRASE.length })
  await a.wait(180)

  // 2. The selection bar, then Branch: the bar becomes the branch composer
  a.mark('bar')
  await a.set({ pop: 'bar' })
  await a.wait(450)
  await a.move({ at: 'bar-branch', x: 0.72, y: 0.62 })
  await a.wait(150)
  await a.click()
  a.mark('composer')
  await a.set({ pop: 'composer', hl: 'mark' })
  await a.wait(350)
  await a.move('rest-type')
  await a.type('bq', BQ, { interval: 34 })
  await a.wait(300)
  await a.move({ at: 'b-submit', x: 0.3, y: 0.6 })
  await a.wait(120)
  await a.click()

  // 3. The fork: the branch pane arrives beside the main pane
  a.mark('fork')
  await a.set({ pop: 'hidden' })
  await a.wait(80)
  a.put({ forked: true, hl: 'anchor' })
  const away = a.move('rest-fork')
  await a.wait(700)
  a.put({ tool: 'run', bLive: true })
  await away

  // 4. Both panes answer. The main thread keeps going: a follow-up there
  //    while the branch reads the stack order.
  if (!compact) {
    a.mark('follow')
    await a.type('q2', Q2, { interval: 34 })
    a.put({ tool: 'done' })
    await a.wait(200)
    a.mark('stream')
    const stream = (async () => {
      for (let i = 1; i <= BA_N; i++) { a.put({ bWords: i }); await a.wait(64) }
      a.put({ bLive: false })
    })()
    await a.move({ at: 'm-send', x: 0.5, y: 0.5 })
    await a.wait(100)
    await a.click()
    a.put({ sent2: true, q2: '', mLive: true })
    await a.wait(380)
    a.put({ mPhase: 'thinking' })
    const off = a.move('rest-end')
    await a.wait(650)
    a.put({ mPhase: 'answer' })
    for (let i = 1; i <= A2_N; i++) { a.put({ mWords: i }); await a.wait(48) }
    await stream
    await off
    a.put({ mLive: false })
  } else {
    await a.wait(600)
    a.put({ tool: 'done' })
    await a.wait(250)
    a.mark('stream')
    for (let i = 1; i <= BA_N; i++) { a.put({ bWords: i }); await a.wait(64) }
    a.put({ bLive: false })
  }
  a.mark('payoff')
  await a.wait(2400)
}

export function MichiHero() {
  return (
    <Stage
      width={1200}
      height={660}
      compact={{ below: 760, width: 358, height: 640 }}
      initial={initial}
      poster={poster}
      script={script}
      play="once"
      fidelity="realistic"
      greys="cool"
      cursor={{ at: REST }}
      className="mh"
    >
      {(s, rect, layout) => <Scene s={s} rect={rect} layout={layout} />}
    </Stage>
  )
}

type Rect = { x: number; y: number; width: number; height: number }

function Scene({ s, rect, layout }: { s: S; rect: (name: string) => Rect; layout: Layout }) {
  const compact = layout === 'compact'
  const phrase = rect('phrase')
  const cx = phrase.x + phrase.width / 2
  const W = compact ? 358 : 1200
  const popW = s.pop === 'composer' || (s.pop === 'hidden' && s.bq) ? (compact ? 326 : 340) : 236
  const popH = s.pop === 'composer' || (s.pop === 'hidden' && s.bq) ? 174 : 32
  const g = compact ? 16 : 300
  const left = Math.max(g, Math.min(W - popW - (compact ? 16 : 24), cx - popW / 2))
  const top = phrase.y - 8 - popH
  return (
    <>
      {compact ? (
        // A phone column has no room for a desktop window: Michi's two panes
        // as pane cards, the branch rising over the main pane's lower half
        <div className="mh-body mh-cbody" data-forked={s.forked || undefined}>
          <div className="mh-panes mh-ccard">
            <MainPane s={s} compact />
          </div>
          <div className="mh-ccard mh-cbranch" data-on={s.forked || undefined}>
            <BranchPane s={s} compact />
          </div>
        </div>
      ) : (
        <Window
          className="mh-win"
          lead={
            <span className="mh-top-icons">
              <PanelLeft size={15} strokeWidth={1.75} />
              <Plus size={15} strokeWidth={1.75} />
              <Search size={15} strokeWidth={1.75} />
            </span>
          }
        >
          <div className="mh-body" data-forked={s.forked || undefined}>
            <Rail />
            <Sidebar forked={s.forked} live={s.bLive} />
            <div className="mh-panes">
              <MainPane s={s} compact={false} />
              <BranchPane s={s} compact={false} />
            </div>
          </div>
        </Window>
      )}

      {/* The selection bar and the branch composer are one surface */}
      <div className="mh-pop" data-mode={s.pop} style={{ left, top, width: popW, height: popH }}>
        <div className="mh-pop-bar">
          <span className="mh-bar-btn" data-target="bar-branch" data-cursor="pointer" data-pressed={undefined}>
            <Split size={12} strokeWidth={1.8} className="mh-r90" />Branch
          </span>
          <i className="mh-bar-sep" />
          <span className="mh-bar-btn"><MessageSquareText size={12} strokeWidth={1.8} />Comment</span>
          <i className="mh-bar-sep" />
          <span className="mh-bar-btn"><Quote size={12} strokeWidth={1.8} />Quote</span>
        </div>
        <div className="mh-pop-comp" style={{ width: compact ? 326 : 340 }}>
          <div className="mh-comp-head"><span>Branch from selection</span><X size={14} strokeWidth={1.75} /></div>
          <div className="mh-comp-quote">{PHRASE}</div>
          <div className="mh-comp-input" data-typing>
            {s.bq ? s.bq : <span className="mh-ph">ask something about this selection…</span>}
            {s.pop === 'composer' && <i className="mh-caret" />}
          </div>
          <div className="mh-comp-foot">
            <span className="mh-comp-btn">Cancel <span className="mh-kbd">Esc</span></span>
            <span className="mh-comp-btn is-submit" data-target="b-submit" data-cursor="pointer">Branch <span className="mh-kbd">↵</span></span>
          </div>
        </div>
      </div>

      <span data-target="rest-type" style={{ position: 'absolute', left: compact ? 304 : cx + 230, top: compact ? top + 200 : top + 120 }} />
      <span data-target="rest-fork" style={{ position: 'absolute', left: compact ? 304 : 620, top: compact ? 92 : 560 }} />
      <span data-target="rest-end" style={{ position: 'absolute', left: 1010, top: 500 }} />
    </>
  )
}

function Rail() {
  return (
    <div className="mh-rail">
      <span className="mh-rail-btn is-on"><MessageSquare size={17} strokeWidth={1.5} /></span>
      <span className="mh-rail-btn"><Layers size={17} strokeWidth={1.5} /></span>
      <span className="mh-rail-btn"><Clock size={17} strokeWidth={1.5} /></span>
    </div>
  )
}

function Sidebar({ forked, live }: { forked: boolean; live: boolean }) {
  return (
    <div className="mh-side">
      <div className="mh-side-label">Projects</div>
      <div className="mh-srow is-project" style={{ ['--c' as string]: '#2f6b4e' }}><span>tokyo-rollout</span></div>
      <div className="mh-srow is-thread is-sel"><span>Tokyo deployment</span><ChevronDown size={12} strokeWidth={1.75} className="mh-caretdown" /><i className="mh-srail" /></div>
      <Collapse open={forked}>
        <div className="mh-srow is-child" data-new={forked || undefined}><span>Task runner role</span><i className="mh-srail" data-live={live || undefined} /></div>
      </Collapse>
      <div className="mh-srow is-thread"><span>RCA template</span></div>
      <div className="mh-side-gap" />
      {[['#8aa2c8', 'design-system'], ['#8fbf9f', 'search-ranking'], ['#c5b3e6', 'mobile-app']].map(([c, name]) => (
        <div key={c} className="mh-srow is-project" style={{ ['--c' as string]: c }}><span>{name}</span></div>
      ))}
      <div className="mh-side-gap" />
      <div className="mh-side-label">Chats</div>
      <div className="mh-side-note">No project chats</div>
    </div>
  )
}

function Segs({ segs, count }: { segs: Seg[]; count: number }) {
  let offset = 0
  return (
    <>
      {segs.map((seg, i) => {
        const n = seg.t.split(' ').length
        const node = <Stream text={seg.t} count={Math.max(0, count - offset)} />
        offset += n
        return (
          <span key={i}>
            {seg.b ? <strong>{node}</strong> : node}
            {i < segs.length - 1 ? ' ' : ''}
          </span>
        )
      })}
    </>
  )
}

function PaneHead({ title, live, icons }: { title: string; live: boolean; icons?: boolean }) {
  return (
    <div className="mh-head">
      <i className="mh-dot" data-live={live || undefined} />
      <span className="mh-head-title">{title}</span>
      {icons && (
        <span className="mh-head-icons">
          <Plus size={14} strokeWidth={1.6} />
          <ListTree size={14} strokeWidth={1.6} />
          <Network size={14} strokeWidth={1.6} />
          <FileText size={14} strokeWidth={1.6} />
          <Layers size={14} strokeWidth={1.6} />
        </span>
      )}
    </div>
  )
}

function User({ time, children }: { time: string; children: React.ReactNode }) {
  return (
    <div className="mh-user">
      <div className="mh-over">You · {time}</div>
      {children}
    </div>
  )
}

function MainPane({ s, compact }: { s: S; compact: boolean }) {
  const n = s.sel
  return (
    <div className="mh-pane mh-main">
      <PaneHead title="Tokyo deployment" live={s.mLive} icons={!compact} />
      <div className="mh-col">
        <div className="mh-thread">
          <div className="mh-msgs">
            <User time="14:05"><div className="mh-utext">{Q1}</div></User>
            <div className="mh-asst">
              <div className="mh-label">&gt; michi</div>
              <Thought label="Thought for 2.1s" />
              <div className="mh-prose">
                <p>{LEAD}</p>
                <ol>
                  <li>
                    <span data-target="item1" data-cursor="ibeam">
                      <strong>{B1}</strong>{ITEM1_REST}
                      <span className="mh-phrase" data-target="phrase" data-hl={s.hl}>
                        <span className="mh-sel">{PHRASE.slice(0, n)}</span>{PHRASE.slice(n)}
                      </span>.
                    </span>
                  </li>
                  <li><strong>{B2}</strong>{ITEM2_REST}</li>
                </ol>
              </div>
            </div>
            {!compact && (
              <>
                <Collapse open={s.sent2} reveal="drop" from="below">
                  <User time="14:07"><div className="mh-utext">{Q2}</div></User>
                </Collapse>
                <Collapse open={s.mPhase !== 'idle'}>
                  <div className="mh-asst">
                    <div className="mh-label">&gt; michi</div>
                    <Collapse open={s.mPhase === 'answer'}>
                      <div className="mh-prose"><p><Segs segs={A2} count={s.mWords} /></p></div>
                    </Collapse>
                  </div>
                </Collapse>
              </>
            )}
          </div>
        </div>
        <Composer text={s.q2} focused send={s.q2 ? 'ready' : s.mLive ? 'stop' : 'empty'} target="m-send" />
      </div>
    </div>
  )
}

function BranchPane({ s, compact }: { s: S; compact: boolean }) {
  return (
    <div className="mh-pane mh-branch" data-on={s.forked || undefined}>
      <PaneHead title="Task runner role" live={s.bLive} />
      <div className="mh-col">
        <div className="mh-thread is-top">
          <div className="mh-msgs">
            <User time="14:07">
              <div className="mh-qchip">
                <div className="mh-qchip-top"><span>replying to <b>selection</b></span></div>
                <div className="mh-qchip-text">{PHRASE}</div>
              </div>
              <div className="mh-utext">{BQ}</div>
            </User>
            <Collapse open={s.tool !== 'hidden'}>
              <div className="mh-asst">
                <div className="mh-label">&gt; michi</div>
                <div className="mh-tool" data-state={s.tool}>
                  <File size={13} strokeWidth={1.6} className="mh-tool-ic" />
                  <div className="mh-tool-t">
                    <div className="mh-tool-title">Read the stack order</div>
                    <div className="mh-tool-sub">Read stacks/order.yaml</div>
                  </div>
                  <span className="mh-tool-end">
                    <i className="mh-tool-run" />
                    <span className="mh-tool-done">0.1s <Check size={12} strokeWidth={2} /></span>
                  </span>
                </div>
                <Collapse open={s.tool === 'done'}>
                  <div className="mh-prose"><p><Segs segs={BA} count={s.bWords} /></p></div>
                </Collapse>
              </div>
            </Collapse>
          </div>
        </div>
        {!compact && <Composer text="" send={s.bLive ? 'stop' : 'empty'} />}
      </div>
    </div>
  )
}

function Thought({ label }: { label: string }) {
  return (
    <div className="mh-thought">
      <Sparkle size={13} strokeWidth={1.6} />
      <span>{label}</span>
      <ChevronDown size={10} strokeWidth={1.75} className="mh-thought-chev" />
    </div>
  )
}

function Composer({ text, focused, send, target }: { text: string; focused?: boolean; send: 'empty' | 'ready' | 'stop'; target?: string }) {
  return (
    <div className="mh-composer" data-focused={focused || undefined}>
      <div className="mh-cin" data-typing>
        <span className="mh-prompt">›_</span>
        <span className="mh-ctext">{text}{focused && <i className="mh-caret mh-caret--dark" data-on={text ? true : undefined} />}</span>
      </div>
      <div className="mh-ctools">
        <span className="mh-ctool-l"><Plus size={14} strokeWidth={1.6} /><AtSign size={14} strokeWidth={1.6} /></span>
        <span className="mh-ctool-r">
          <span className="mh-model"><b>Opus 5</b> High <ChevronDown size={12} strokeWidth={1.75} /></span>
          <span className="mh-send" data-state={send} data-target={target} data-cursor={target ? 'pointer' : undefined}>
            <span className="mh-send-up"><ArrowUp size={14} strokeWidth={2.2} /></span>
            <span className="mh-send-stop"><Square size={9} strokeWidth={0} fill="currentColor" /></span>
          </span>
        </span>
      </div>
    </div>
  )
}
