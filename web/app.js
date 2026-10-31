// Webbgränssnitt för granskning. Pratar bara med samma servers /v1-API med en API-nyckel.
// Säkerhetsregler för den här filen (kontrolleras av test/web.test.ts):
//  - aldrig API:er som tolkar text som HTML eller kod (se listan i testet): all text sätts som ren text,
//    eftersom texter (referenser, felmeddelanden) kommer från externa källor
//  - inga inline-skript eller händelseattribut i HTML (Content-Security-Policy tillåter dem inte)
//  - API-nyckeln ligger bara i sessionStorage (försvinner när fliken stängs) och skickas bara till /v1

import {
  COMMAND_KIND,
  COMMAND_STATUS,
  EXCEPTION_INFO,
  EXCEPTION_STATUS,
  ONBOARDING_PHASE,
  PAGES,
  PAYOUT_STATUS,
  ROLE_LABEL,
  ageText,
  apiErrorMessage,
  describeCommand,
  formatAmount,
  formatPercent,
  parseHash,
  validateGoLive,
  validateGuardResolve,
  validateResolve,
  voucherBalance,
} from './lib.js';

const KEY_STORE = 'synkenpluz.apiKey';
const PAGE_LABEL = {
  oversikt: 'Översikt',
  start: 'Kom igång',
  forslag: 'Förslag',
  utbetalningar: 'Utbetalningar',
  avvikelser: 'Avvikelser',
  osakra: 'Osäkra anrop',
};

// ----------------------------------------------------------------------------------------- DOM-hjälpare

/** Skapar ett element. Barn som är text sätts alltid som text, aldrig som HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') el.className = value;
    else if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2), value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const badge = (tone, text) => h('span', { class: `badge ${tone}` }, text);
const when = (iso) => (iso ? new Date(iso).toLocaleString('sv-SE') : '–');
const link = (hash, text) => h('a', { href: hash }, text);
const hashFor = (page, id) => `#/${page}${id ? `/${encodeURIComponent(id)}` : ''}`;

function table(headers, rows, { caption } = {}) {
  return h(
    'div',
    { class: 'tablewrap' },
    h(
      'table',
      {},
      caption ? h('caption', { class: 'muted' }, caption) : null,
      h('thead', {}, h('tr', {}, headers.map((x) => h('th', { scope: 'col', class: x.num ? 'num' : '' }, x.label ?? x)))),
      h('tbody', {}, rows),
    ),
  );
}

let toastTimer;
function toast(message) {
  const region = document.getElementById('toast');
  region.replaceChildren(h('div', { class: 'msg' }, message));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => region.replaceChildren(), 5000);
}

/** Bekräftelsedialog (inbyggd <dialog>). Returnerar true om användaren bekräftar. */
function confirmDialog({ title, body, confirmLabel, danger = false }) {
  const dialog = document.getElementById('dialog');
  return new Promise((resolve) => {
    const finish = (value) => {
      dialog.close();
      dialog.replaceChildren();
      resolve(value);
    };
    dialog.replaceChildren(
      h('h2', { id: 'dialog-title' }, title),
      ...[body].flat(),
      h(
        'div',
        { class: 'row' },
        h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', onclick: () => finish(true) }, confirmLabel),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => finish(false), autofocus: true }, 'Avbryt'),
      ),
    );
    dialog.addEventListener('cancel', () => resolve(false), { once: true });
    dialog.showModal();
  });
}

// ----------------------------------------------------------------------------------------- API

let apiKey = null;
try {
  apiKey = sessionStorage.getItem(KEY_STORE);
} catch {
  apiKey = null;
}

class ApiError extends Error {
  constructor(status, body, retryAfter) {
    super(apiErrorMessage(status, body, retryAfter ? Number(retryAfter) : undefined));
    this.status = status;
  }
}

/** `keepOn401`: vid inloggning ska ett 401 visas som fel i formuläret, inte rita om sidan. */
async function api(method, path, body, { keepOn401 = false, asBlob = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      cache: 'no-store',
      headers: { 'x-api-key': apiKey ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(0, null);
  }
  // En fil (t.ex. CSV) hämtas som blob när svaret är ok. Felsvar är alltid JSON.
  if (asBlob && response.ok) return response.blob();
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    if (response.status === 401 && !keepOn401) logout(false);
    throw new ApiError(response.status, json, response.headers.get('retry-after'));
  }
  return json;
}

function logout(navigate = true) {
  apiKey = null;
  try {
    sessionStorage.removeItem(KEY_STORE);
  } catch {
    /* ignoreras */
  }
  if (navigate) location.hash = '';
  void route();
}

// ----------------------------------------------------------------------------------------- vyer

const main = document.getElementById('main');

function setView(title, ...content) {
  document.title = `${title} · Granskning`;
  // Plattar ut helt och tar bort tomma värden: replaceChildren skriver annars ut listor och null som text.
  main.replaceChildren(h('h2', {}, title), ...content.flat(Infinity).filter((node) => node !== null && node !== undefined && node !== false));
}

function errorBox(error) {
  return h('p', { class: 'error', role: 'alert' }, error instanceof ApiError ? error.message : 'Något gick fel.');
}

async function load(title, produce) {
  setView(title, h('p', { class: 'muted' }, 'Laddar…'));
  try {
    const content = await produce();
    setView(title, ...[content].flat());
  } catch (error) {
    setView(title, errorBox(error));
  }
}

function pagedList({ path, query = {}, render, empty }) {
  const wrap = h('div', {});
  const list = h('div', {});
  const more = h('div', { class: 'row' });
  wrap.append(list, more);
  let offset = 0;
  const limit = 50;
  const fetchPage = async () => {
    const params = new URLSearchParams({ ...query, limit: String(limit), offset: String(offset) });
    const data = await api('GET', `${path}?${params}`);
    if (offset === 0 && data.items.length === 0) list.append(h('p', { class: 'muted' }, empty));
    else list.append(render(data.items));
    offset += data.items.length;
    // Inget null här: replaceChildren(null) skriver ut texten "null".
    more.replaceChildren(...(data.hasMore ? [h('button', { class: 'btn ghost', type: 'button', onclick: loadMore }, 'Visa fler')] : []));
  };
  const loadMore = async () => {
    try {
      await fetchPage();
    } catch (error) {
      more.replaceChildren(errorBox(error));
    }
  };
  return fetchPage().then(() => wrap);
}

// --- inloggning
function loginView() {
  document.title = 'Logga in · Granskning';
  const error = h('p', { class: 'error', role: 'alert' });
  const input = h('input', { id: 'key', type: 'password', autocomplete: 'off', spellcheck: 'false', required: true });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Logga in');
  const form = h(
    'form',
    {
      novalidate: true, // JavaScript validerar med samma regler som API:t och visar felet tillgängligt (role=alert)
      class: 'card login',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        apiKey = input.value.trim();
        try {
          await api('GET', '/v1/payouts?limit=1', undefined, { keepOn401: true });
          try {
            sessionStorage.setItem(KEY_STORE, apiKey);
          } catch {
            /* ignoreras: sessionen blir bara inte kvar vid omladdning */
          }
          location.hash = '#/';
          await route();
        } catch (e) {
          apiKey = null;
          error.textContent = e instanceof ApiError ? e.message : 'Något gick fel.';
          submit.disabled = false;
          input.focus();
        }
      },
    },
    h('h2', {}, 'Logga in'),
    h('p', { class: 'muted' }, 'Ange din API-nyckel. Den sparas bara i den här fliken och försvinner när du stänger den.'),
    h('div', { class: 'field' }, h('label', { for: 'key' }, 'API-nyckel'), input),
    error,
    submit,
  );
  main.replaceChildren(form);
  input.focus();
}

// --- översikt
async function overviewView() {
  const [proposals, payouts, exceptions, inDoubt] = await Promise.all([
    api('GET', '/v1/proposals?limit=500').catch((e) => (e.status === 404 ? null : Promise.reject(e))),
    api('GET', '/v1/payouts?limit=500'),
    api('GET', '/v1/exceptions?status=open&limit=500'),
    api('GET', '/v1/guard/in-doubt?limit=500').catch((e) => (e.status === 404 ? null : Promise.reject(e))),
  ]);
  const count = (data) => (data ? `${data.items.length}${data.hasMore ? '+' : ''}` : '–');
  const partial = payouts.items.filter((p) => p.status === 'partial').length;
  const rejected = payouts.items.filter((p) => p.status === 'rejected').length;

  const attention = [];
  if (inDoubt && inDoubt.items.length > 0) {
    attention.push(
      h('div', { class: 'alert bad', role: 'alert' }, h('strong', {}, `${inDoubt.items.length} osäkra anrop väntar på dig. `), 'Utfallet av ett bokföringsanrop är okänt. ', link('#/osakra', 'Gå till osäkra anrop')),
    );
  }
  if (rejected > 0) attention.push(h('div', { class: 'alert warn' }, `${rejected} utbetalning(ar) har avvisats och inget har bokförts. `, link('#/utbetalningar', 'Visa utbetalningar')));
  if (exceptions.items.length > 0) attention.push(h('div', { class: 'alert warn' }, `${count(exceptions)} öppna avvikelser kräver granskning. `, link('#/avvikelser', 'Visa avvikelser')));
  if (attention.length === 0) attention.push(h('div', { class: 'alert ok' }, 'Inget kräver din uppmärksamhet just nu.'));

  const stat = (hash, n, label, help) =>
    h('a', { class: 'card stat', href: hash }, h('div', { class: 'n' }, n), h('div', {}, label), h('div', { class: 'muted' }, help));
  return [
    ...attention,
    h(
      'div',
      { class: 'grid' },
      stat('#/forslag', count(proposals), 'Förslag att granska', 'Vad som skulle bokföras i testläge. Inget har bokförts.'),
      stat('#/avvikelser', count(exceptions), 'Öppna avvikelser', 'Rader som inte kunde stämmas av automatiskt.'),
      stat('#/utbetalningar', String(partial), 'Delvis avstämda', 'Väntar på att avvikelser löses.'),
      stat('#/osakra', count(inDoubt), 'Osäkra anrop', 'Utfallet är okänt och måste avgöras av en människa.'),
    ),
    h('p', { class: 'muted' }, `Utbetalningar totalt: ${count(payouts)}. Siffror över 500 visas som 500+.`),
  ];
}

// --- förslag
function proposalsView() {
  return pagedList({
    path: '/v1/proposals',
    empty: 'Inga sparade förslag. Förslag skapas när kunden körs i testläge.',
    render: (items) =>
      table(
        ['Utbetalning', 'Status', { label: 'Kommandon', num: true }, { label: 'Avvikelser', num: true }, 'Uppdaterad'],
        items.map((p) =>
          h(
            'tr',
            {},
            h('td', {}, link(hashFor('forslag', p.payoutId), p.payoutId)),
            h('td', {}, badge(PAYOUT_STATUS[p.status]?.tone ?? 'neutral', PAYOUT_STATUS[p.status]?.label ?? p.status)),
            h('td', { class: 'num' }, p.commandCount),
            h('td', { class: 'num' }, p.exceptionCount),
            h('td', {}, `${ageText(p.updatedAt)} sedan`),
          ),
        ),
      ),
  });
}

function exceptionExplanation(code) {
  const info = EXCEPTION_INFO[code];
  if (!info) return h('p', { class: 'muted' }, 'Okänd avvikelsekod. Kontakta den som driftar tjänsten.');
  return h('div', {}, h('p', {}, h('strong', {}, 'Vad det betyder: '), info.meaning), h('p', {}, h('strong', {}, 'Vad du kan göra: '), info.action));
}

/** Hämtar underlaget som fil. Nyckeln skickas som header, så det går inte att göra med en vanlig länk. */
function csvButton(payoutId) {
  const error = h('span', { class: 'error', role: 'alert' });
  const button = h('button', { class: 'btn ghost', type: 'button' }, 'Ladda ner underlag (CSV)');
  button.addEventListener('click', async () => {
    error.textContent = '';
    button.disabled = true;
    try {
      const blob = await api('GET', `/v1/proposals/${encodeURIComponent(payoutId)}/export.csv`, undefined, { asBlob: true });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `forslag-${payoutId.replace(/[^A-Za-z0-9._-]/g, '_')}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      error.textContent = e instanceof ApiError ? e.message : 'Något gick fel.';
    }
    button.disabled = false;
  });
  return h('span', {}, button, ' ', error);
}

async function proposalDetailView(payoutId) {
  const p = await api('GET', `/v1/proposals/${encodeURIComponent(payoutId)}`);
  const status = PAYOUT_STATUS[p.status];
  const blocks = [
    h('p', {}, link('#/forslag', '← Alla förslag'), ' ', csvButton(payoutId)),
    h('div', { class: 'alert' }, h('strong', {}, 'Det här är bara ett förslag. '), 'Inget har bokförts. Så här skulle utbetalningen bokföras i live-läge, med nuvarande uppgifter.'),
    h('p', {}, badge(status?.tone ?? 'neutral', status?.label ?? p.status), ' ', h('span', { class: 'muted' }, status?.help ?? '')),
  ];

  blocks.push(h('h3', {}, `Så här skulle det bokföras (${p.commands.length})`));
  if (p.commands.length === 0) blocks.push(h('p', { class: 'muted' }, 'Inga kommandon. Det finns inget att bokföra förrän avvikelserna är lösta.'));
  for (const command of p.commands) {
    const d = describeCommand(command);
    const card = h('div', { class: 'card' }, h('strong', {}, d.title), h('dl', { class: 'rows' }, d.rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    if (d.voucher) {
      const sums = voucherBalance(d.voucher);
      card.append(
        h(
          'div',
          { class: 'tablewrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, [h('th', { scope: 'col' }, 'Konto'), h('th', { scope: 'col', class: 'num' }, 'Debet'), h('th', { scope: 'col', class: 'num' }, 'Kredit')])),
            h(
              'tbody',
              {},
              d.voucher.map((l) =>
                h('tr', {}, h('td', { class: 'mono' }, l.account), h('td', { class: 'num' }, l.debit ? formatAmount(l.debit) : ''), h('td', { class: 'num' }, l.credit ? formatAmount(l.credit) : '')),
              ),
            ),
            h('tfoot', {}, h('tr', {}, [h('td', {}, 'Summa'), h('td', { class: 'num' }, formatAmount(sums.debit)), h('td', { class: 'num' }, formatAmount(sums.credit))])),
          ),
        ),
        sums.balanced ? badge('ok', 'Verifikatet balanserar') : badge('bad', 'Verifikatet balanserar inte'),
      );
    }
    blocks.push(card);
  }

  blocks.push(h('h3', {}, `Avvikelser (${p.exceptions.length})`));
  if (p.exceptions.length === 0) blocks.push(h('p', { class: 'muted' }, 'Inga avvikelser. Alla rader kunde stämmas av.'));
  for (const e of p.exceptions) {
    const info = EXCEPTION_INFO[e.code];
    blocks.push(
      h(
        'div',
        { class: 'card' },
        h('strong', {}, info?.title ?? e.code),
        ' ',
        e.lineId ? h('span', { class: 'muted' }, 'Rad ') : null,
        e.lineId ? h('span', { class: 'mono' }, e.lineId) : null,
        h('p', {}, e.message),
        exceptionExplanation(e.code),
      ),
    );
  }
  document.title = `Förslag ${payoutId} · Granskning`;
  return blocks;
}

// --- utbetalningar
async function payoutsView() {
  const select = h('select', { id: 'f-status', 'aria-label': 'Filtrera på status' }, [
    h('option', { value: '' }, 'Alla'),
    ...Object.entries(PAYOUT_STATUS).map(([value, v]) => h('option', { value }, v.label)),
  ]);
  const holder = h('div', {});
  const refresh = async () => {
    holder.replaceChildren(h('p', { class: 'muted' }, 'Laddar…'));
    try {
      holder.replaceChildren(
        await pagedList({
          path: '/v1/payouts',
          query: select.value ? { status: select.value } : {},
          empty: 'Inga utbetalningar.',
          render: (items) =>
            table(
              ['Utbetalning', 'Status', 'Senast bearbetad'],
              items.map((p) =>
                h('tr', {}, h('td', {}, link(hashFor('utbetalningar', p.payoutId), p.payoutId)), h('td', {}, badge(PAYOUT_STATUS[p.status]?.tone ?? 'neutral', PAYOUT_STATUS[p.status]?.label ?? p.status)), h('td', {}, `${ageText(p.processedAt)} sedan`)),
              ),
            ),
        }),
      );
    } catch (error) {
      holder.replaceChildren(errorBox(error));
    }
  };
  select.addEventListener('change', refresh);
  await refresh();
  return [h('div', { class: 'row' }, h('label', { for: 'f-status' }, 'Status'), select), holder];
}

async function payoutDetailView(payoutId) {
  const [p, open] = await Promise.all([
    api('GET', `/v1/payouts/${encodeURIComponent(payoutId)}`),
    api('GET', `/v1/exceptions?payoutId=${encodeURIComponent(payoutId)}&status=open&limit=100`),
  ]);
  const status = PAYOUT_STATUS[p.status];
  const hasDead = p.commands.some((c) => c.status === 'dead');
  const blocks = [
    h('p', {}, link('#/utbetalningar', '← Alla utbetalningar')),
    h('p', {}, badge(status?.tone ?? 'neutral', status?.label ?? p.status), ' ', h('span', { class: 'muted' }, status?.help ?? '')),
  ];
  if (hasDead) {
    blocks.push(h('div', { class: 'alert bad', role: 'alert' }, h('strong', {}, 'Ett kommando har misslyckats permanent. '), 'Det blockerar resten av utbetalningen tills du åtgärdat orsaken. Kontrollera i affärssystemet innan du köar om det. ', link('#/osakra', 'Se osäkra anrop')));
  }
  blocks.push(h('h3', {}, 'Kommandon i ordning'));
  blocks.push(
    table(
      ['#', 'Typ', 'Status', { label: 'Försök', num: true }, 'Nästa försök', ''],
      p.commands.map((c, i) =>
        h(
          'tr',
          {},
          h('td', {}, i + 1),
          h('td', {}, COMMAND_KIND[c.kind] ?? c.kind),
          h('td', {}, badge(COMMAND_STATUS[c.status]?.tone ?? 'neutral', COMMAND_STATUS[c.status]?.label ?? c.status), c.hasError ? h('div', { class: 'muted' }, 'Fel registrerat') : null),
          h('td', { class: 'num' }, c.attempts),
          h('td', {}, c.status === 'succeeded' ? '–' : when(c.nextAttemptAt)),
          h('td', {}, c.status === 'dead' ? h('button', { class: 'btn danger', type: 'button', onclick: () => requeue(c, payoutId) }, 'Köa om') : null),
        ),
      ),
      { caption: 'Kommandon utförs i ordning. Nästa körs först när föregående lyckats.' },
    ),
  );
  blocks.push(h('h3', {}, `Öppna avvikelser (${open.items.length}${open.hasMore ? '+' : ''})`));
  blocks.push(open.items.length === 0 ? h('p', { class: 'muted' }, 'Inga öppna avvikelser för den här utbetalningen.') : h('p', {}, link('#/avvikelser', 'Hantera under Avvikelser')));
  open.items.forEach((e) => blocks.push(h('p', {}, h('strong', {}, EXCEPTION_INFO[e.code]?.title ?? e.code), ': ', e.message)));
  document.title = `Utbetalning ${payoutId} · Granskning`;
  return blocks;
}

async function requeue(command, payoutId) {
  const ok = await confirmDialog({
    title: 'Köa om kommandot?',
    body: [
      h('p', {}, h('strong', {}, 'Kontrollera i affärssystemet först.'), ' Om kommandot redan utförts där kan en omkörning ge dubbelbokning.'),
      h('p', { class: 'muted' }, 'Är utfallet okänt: avgör det under Osäkra anrop innan du köar om. Åtgärden loggas.'),
    ],
    confirmLabel: 'Köa om',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', `/v1/commands/${encodeURIComponent(command.id)}/retry`);
    toast('Kommandot är köat och körs vid nästa omgång.');
  } catch (error) {
    toast(error instanceof ApiError ? error.message : 'Något gick fel.');
  }
  await route();
}

// --- avvikelser
async function exceptionsView() {
  const select = h('select', { id: 'f-status', 'aria-label': 'Filtrera på status' }, [
    h('option', { value: 'open' }, 'Öppna'),
    h('option', { value: 'resolved' }, 'Lösta'),
    h('option', { value: 'dismissed' }, 'Avfärdade'),
  ]);
  const holder = h('div', {});
  const refresh = async () => {
    holder.replaceChildren(h('p', { class: 'muted' }, 'Laddar…'));
    try {
      holder.replaceChildren(
        await pagedList({
          path: '/v1/exceptions',
          query: { status: select.value },
          empty: select.value === 'open' ? 'Inga öppna avvikelser. Bra!' : 'Inga avvikelser med den statusen.',
          render: (items) => h('div', {}, items.map((e) => exceptionItem(e, refresh))),
        }),
      );
    } catch (error) {
      holder.replaceChildren(errorBox(error));
    }
  };
  select.addEventListener('change', refresh);
  await refresh();
  return [h('div', { class: 'row' }, h('label', { for: 'f-status' }, 'Visa'), select), holder];
}

function exceptionItem(e, refresh) {
  const info = EXCEPTION_INFO[e.code];
  const st = EXCEPTION_STATUS[e.status];
  const body = h('div', { class: 'body' }, h('p', {}, e.message), exceptionExplanation(e.code));
  body.append(
    h('dl', { class: 'rows' }, h('dt', {}, 'Utbetalning'), h('dd', {}, link(hashFor('utbetalningar', e.payoutId), e.payoutId)), e.lineId ? [h('dt', {}, 'Rad'), h('dd', { class: 'mono' }, e.lineId)] : [], h('dt', {}, 'Skapad'), h('dd', {}, when(e.createdAt))),
  );
  if (e.status === 'open') body.append(resolveForm(e, refresh));
  else body.append(h('dl', { class: 'rows' }, h('dt', {}, 'Stängd'), h('dd', {}, when(e.resolvedAt)), h('dt', {}, 'Anteckning'), h('dd', {}, e.resolutionNote ?? '–')));
  return h('details', { class: 'item' }, h('summary', {}, badge(st?.tone ?? 'neutral', st?.label ?? e.status), h('strong', {}, info?.title ?? e.code), h('span', { class: 'muted' }, `${ageText(e.createdAt)} sedan`)), body);
}

function resolveForm(e, refresh) {
  const error = h('p', { class: 'error', role: 'alert' });
  const note = h('textarea', { id: `note-${e.id}`, maxlength: '2000', required: true });
  const choice = (value, label, checked) =>
    h('label', { class: 'choice' }, h('input', { type: 'radio', name: `st-${e.id}`, value, checked }), label);
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Stäng avvikelse');
  return h(
    'form',
    {
      novalidate: true, // JavaScript validerar med samma regler som API:t och visar felet tillgängligt (role=alert)
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        const status = event.currentTarget.querySelector('input[type=radio]:checked')?.value;
        const problem = validateResolve({ status, note: note.value });
        if (problem) {
          error.textContent = problem;
          return;
        }
        const ok = await confirmDialog({
          title: 'Stäng avvikelsen?',
          body: [h('p', {}, 'Avvikelsen stängs, men ingenting bokförs av det. Bokföringen måste redan vara gjord manuellt, eller inte behövas. Åtgärden loggas.')],
          confirmLabel: 'Stäng avvikelse',
        });
        if (!ok) return;
        submit.disabled = true;
        try {
          await api('POST', `/v1/exceptions/${encodeURIComponent(e.id)}/resolve`, { status, note: note.value.trim() });
          toast('Avvikelsen är stängd.');
          await refresh();
        } catch (err) {
          error.textContent = err instanceof ApiError ? err.message : 'Något gick fel.';
          submit.disabled = false;
        }
      },
    },
    h('h3', {}, 'Stäng avvikelsen'),
    h('fieldset', {}, h('legend', {}, 'Hur ska den stängas?'), choice('resolved', 'Löst: jag har åtgärdat orsaken eller bokfört manuellt', true), choice('dismissed', 'Avfärdad: ingen åtgärd behövs', false)),
    h('div', { class: 'field' }, h('label', { for: `note-${e.id}` }, 'Anteckning (krävs, visas inte i revisionsloggen)'), note),
    error,
    submit,
  );
}

// --- kom igång (onboarding)
async function startView() {
  let status;
  try {
    status = await api('GET', '/v1/onboarding');
  } catch (error) {
    if (error.status === 404) return [h('p', { class: 'muted' }, 'Funktionen är inte aktiverad på servern.')];
    throw error;
  }
  const phase = ONBOARDING_PHASE[status.phase] ?? { label: status.phase, tone: 'neutral', help: '' };

  const steps = h(
    'ol',
    { class: 'steps' },
    status.steps.map((step) =>
      h(
        'li',
        {},
        h('div', { class: 'row' }, badge(step.done ? 'ok' : 'warn', step.done ? 'Klart' : 'Återstår'), h('strong', {}, step.label)),
        step.done || status.phase === 'live' ? null : h('p', { class: 'muted' }, step.hint),
      ),
    ),
  );

  return [
    h('div', { class: 'row' }, badge(phase.tone, phase.label), h('span', { class: 'muted' }, phase.help)),
    h('div', { class: 'card' }, h('h3', {}, 'Checklista'), steps),
    await summaryCard(),
    status.ledger ? ledgerCard(status.ledger) : null,
    status.phase === 'review' ? goLiveCard(status) : null,
    status.phase === 'live' ? h('div', { class: 'alert ok' }, 'Kunden bokför på riktigt. Nya utbetalningar bokförs i affärssystemet så fort de hittats.') : null,
  ];
}

/** Hur stor del av förslagen som kan bokföras automatiskt. Utelämnas om servern saknar förslag eller inget finns än. */
async function summaryCard() {
  let s;
  try {
    s = await api('GET', '/v1/proposals/summary');
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  if (s.payouts.total === 0) return null;
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Träffsäkerhet i testläge'),
    h('p', {}, h('strong', {}, formatPercent(s.lineMatchRate)), ` av raderna matchades säkert mot en faktura (${s.lines.matched} av ${s.lines.matched + s.lines.unmatched}).`),
    h('p', {}, h('strong', {}, formatPercent(s.fullyAutomaticRate)), ` av utbetalningarna blir helt klara utan mänsklig hjälp (${s.payouts.complete} av ${s.payouts.total}).`),
    s.exceptionsByCode.length > 0
      ? table(
          ['Avvikelse', { label: 'Antal', num: true }, 'Vad det betyder'],
          s.exceptionsByCode.map((e) => h('tr', {}, h('td', {}, EXCEPTION_INFO[e.code]?.title ?? e.code), h('td', { class: 'num' }, String(e.count)), h('td', {}, EXCEPTION_INFO[e.code]?.meaning ?? 'Okänd avvikelsekod.'))),
        )
      : h('p', { class: 'muted' }, 'Inga avvikelser.'),
    h('p', { class: 'muted' }, 'Siffrorna avser bara de utbetalningar som hittills hämtats i testläge. Inget har bokförts.'),
  );
}

function ledgerCard(ledger) {
  const result = h('div', { role: 'status' });
  const button = h('button', { class: 'btn ghost', type: 'button' }, 'Testa anslutningen');
  button.addEventListener('click', async () => {
    button.disabled = true;
    result.replaceChildren(h('p', { class: 'muted' }, 'Testar…'));
    try {
      const check = await api('POST', '/v1/onboarding/check-connection');
      result.replaceChildren(
        check.ok
          ? h('div', { class: 'alert ok' }, 'Anslutningen fungerar.')
          : h('div', { class: 'alert bad', role: 'alert' }, h('strong', {}, 'Anslutningen fungerar inte.'), h('ul', {}, check.problems.map((p) => h('li', {}, p)))),
      );
    } catch (error) {
      result.replaceChildren(errorBox(error));
    }
    button.disabled = false;
  });
  const can = (value) => badge(value ? 'ok' : 'warn', value ? 'Ja' : 'Nej');
  const c = ledger.capabilities;
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, `Affärssystem: ${ledger.provider}`),
    table(
      ['Förmåga', 'Stöds'],
      [
        ['Söka faktura på referens', c.searchByReference],
        ['Idempotenta skrivningar', c.idempotentWrites],
        ['Avgöra osäkra utfall själv', c.verifyByReference],
        ['Kreditera fakturor', c.creditInvoice],
        ['Skapa verifikat', c.postVoucher],
      ].map(([label, value]) => h('tr', {}, h('td', {}, label), h('td', {}, can(value)))),
    ),
    ledger.notes.length > 0 ? h('div', { class: 'alert warn' }, h('ul', {}, ledger.notes.map((n) => h('li', {}, n)))) : null,
    button,
    result,
  );
}

function goLiveCard(status) {
  const { count, withExceptions } = status.proposals;
  if (status.you && !status.you.canApprove) {
    return h(
      'div',
      { class: 'card' },
      h('h3', {}, 'Godkänn och gå live'),
      h('div', { class: 'alert warn' }, `Din nyckel har rollen ${ROLE_LABEL[status.you.role] ?? status.you.role}. Det krävs rollen ${ROLE_LABEL.approver} för att godkänna. Be en kollega med den rollen granska och godkänna.`),
      h('p', {}, `${count} förslag väntar. `, link('#/forslag', 'Granska förslagen')),
    );
  }
  const error = h('p', { class: 'error', role: 'alert' });
  const reviewed = h('input', { id: 'reviewed', type: 'checkbox' });
  const submit = h('button', { class: 'btn danger', type: 'submit' }, 'Godkänn och gå live');
  return h(
    'form',
    {
      novalidate: true,
      class: 'card',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        const problem = validateGoLive({ reviewed: reviewed.checked });
        if (problem) {
          error.textContent = problem;
          return;
        }
        const ok = await confirmDialog({
          title: 'Bekräfta: gå live',
          body: [
            h('p', {}, `Alla ${count} förslag bokförs på riktigt i affärssystemet, och därefter varje ny utbetalning.`),
            h('p', {}, h('strong', {}, 'Det går inte att ångra härifrån. '), 'Åtgärden loggas med ditt nyckel-id.'),
          ],
          confirmLabel: 'Ja, gå live',
          danger: true,
        });
        if (!ok) return;
        submit.disabled = true;
        try {
          await api('POST', '/v1/onboarding/go-live', { approvedProposalCount: count });
          toast('Kunden är live.');
          await route();
        } catch (err) {
          error.textContent = err instanceof ApiError ? err.message : 'Något gick fel.';
          submit.disabled = false;
        }
      },
    },
    h('h3', {}, 'Godkänn och gå live'),
    h('p', {}, `${count} förslag väntar. `, withExceptions > 0 ? h('strong', {}, `${withExceptions} av dem har avvikelser som blir öppna avvikelser när de bokförs. `) : null, link('#/forslag', 'Granska förslagen')),
    h('div', { class: 'alert warn' }, 'Att godkänna betyder att allt du har granskat bokförs på riktigt, inklusive utbetalningar från testperioden. Är du osäker: avstå och fråga redovisningskonsulten.'),
    h('label', { class: 'choice', for: 'reviewed' }, reviewed, 'Jag har granskat förslagen och de stämmer.'),
    error,
    submit,
  );
}

// --- osäkra anrop
async function inDoubtView() {
  const intro = h(
    'div',
    { class: 'alert warn' },
    h('strong', {}, 'Så här fungerar osäkra anrop. '),
    'Systemet skickar aldrig om ett kommando när det är okänt om affärssystemet tog emot det första gången, eftersom det kunde ge dubbelbokning. ',
    h('strong', {}, 'Kontrollera i affärssystemet'),
    ' om bokföringen finns (inbetalning, kreditering eller verifikat) innan du avgör. Gissa aldrig. Är du osäker: lämna den och fråga.',
  );
  let data;
  try {
    data = await api('GET', '/v1/guard/in-doubt?limit=100');
  } catch (error) {
    if (error.status === 404) return [intro, h('p', { class: 'muted' }, 'Funktionen är inte aktiverad på servern.')];
    throw error;
  }
  const items = data.items.map((g) => inDoubtItem(g));
  return [intro, data.items.length === 0 ? h('p', { class: 'muted' }, 'Inga osäkra anrop. Bra!') : items, data.hasMore ? h('p', { class: 'muted' }, 'Fler finns. Avgör de här först och uppdatera sedan.') : null];
}

function inDoubtItem(g) {
  const error = h('p', { class: 'error', role: 'alert' });
  const ext = h('input', { id: `ext-${g.key}`, type: 'text', autocomplete: 'off', maxlength: '200' });
  const radio = (value, label) => h('label', { class: 'choice' }, h('input', { type: 'radio', name: `ap-${g.key}`, value }), label);
  const submit = h('button', { class: 'btn danger', type: 'submit' }, 'Avgör');
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'row' }, badge('bad', 'Okänt utfall'), h('span', { class: 'muted' }, `Startade ${ageText(g.startedAt)} sedan (${when(g.startedAt)})`)),
    h('p', { class: 'mono' }, g.key),
    h(
      'form',
      {
        onsubmit: async (event) => {
          event.preventDefault();
          error.textContent = '';
          const picked = event.currentTarget.querySelector('input[type=radio]:checked')?.value;
          const applied = picked === 'yes' ? true : picked === 'no' ? false : undefined;
          const problem = validateGuardResolve({ applied, externalId: ext.value });
          if (problem) {
            error.textContent = problem;
            return;
          }
          const ok = await confirmDialog({
            title: applied ? 'Bekräfta: kommandot utfördes' : 'Bekräfta: kommandot utfördes inte',
            body: [
              h('p', {}, applied ? 'Kommandot markeras som utfört med det id du angav och skickas aldrig om.' : 'Kommandot får skickas på riktigt nästa gång du köar om det.'),
              h('p', {}, h('strong', {}, 'Ett felaktigt svar ger '), applied ? 'en bokföring som aldrig görs.' : 'dubbelbokning.', ' Åtgärden loggas och går inte att ångra härifrån.'),
            ],
            confirmLabel: applied ? 'Ja, det utfördes' : 'Ja, det utfördes inte',
            danger: true,
          });
          if (!ok) return;
          submit.disabled = true;
          try {
            await api('POST', '/v1/guard/resolve', { key: g.key, applied, ...(applied ? { externalId: ext.value.trim() } : {}) });
            toast('Avgjort. Köa nu om det döda kommandot under Utbetalningar.');
            await route();
          } catch (err) {
            error.textContent = err instanceof ApiError ? err.message : 'Något gick fel.';
            submit.disabled = false;
          }
        },
      },
      h('fieldset', {}, h('legend', {}, 'Vad visar affärssystemet?'), radio('yes', 'Det utfördes (bokföringen finns där)'), radio('no', 'Det utfördes inte (bokföringen saknas)')),
      h('div', { class: 'field' }, h('label', { for: `ext-${g.key}` }, 'Id i affärssystemet (krävs när det utfördes)'), ext),
      error,
      submit,
    ),
  );
}

// ----------------------------------------------------------------------------------------- routing

const VIEWS = {
  oversikt: () => load('Översikt', overviewView),
  start: () => load('Kom igång', startView),
  forslag: ({ id }) => load(id ? `Förslag ${id}` : 'Förslag', () => (id ? proposalDetailView(id) : proposalsView())),
  utbetalningar: ({ id }) => load(id ? `Utbetalning ${id}` : 'Utbetalningar', () => (id ? payoutDetailView(id) : payoutsView())),
  avvikelser: () => load('Avvikelser', exceptionsView),
  osakra: () => load('Osäkra anrop', inDoubtView),
};

function renderNav(current) {
  const nav = document.getElementById('nav');
  nav.hidden = false;
  nav.replaceChildren(...PAGES.map((page) => h('a', { href: hashFor(page), 'aria-current': page === current ? 'page' : null }, PAGE_LABEL[page])));
  document.getElementById('logout').hidden = false;
}

async function route() {
  if (!apiKey) {
    document.getElementById('nav').hidden = true;
    document.getElementById('logout').hidden = true;
    loginView();
    return;
  }
  const parsed = parseHash(location.hash);
  renderNav(parsed.page);
  await VIEWS[parsed.page](parsed);
  main.focus({ preventScroll: true });
}

document.getElementById('logout').addEventListener('click', () => logout(true));
window.addEventListener('hashchange', () => void route());
void route();
