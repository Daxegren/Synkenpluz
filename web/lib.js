// Ren logik för webbgränssnittet. Ingen DOM, inga anrop: går att enhetstesta (test/web.test.ts).
// Texterna är på svenska och bygger på docs/RUNBOOK.md.

/** Belopp i minsta enhet (heltal) till text, utan flyttal: 149000 -> "1 490,00 kr". */
export function formatAmount(minor, currency = 'SEK') {
  if (!Number.isSafeInteger(minor)) return '–';
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const frac = String(abs % 100).padStart(2, '0');
  const whole = String((abs - (abs % 100)) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const unit = currency === 'SEK' ? 'kr' : currency;
  return `${negative ? '−' : ''}${whole},${frac} ${unit}`;
}

/** Hur länge sedan: "just nu", "5 min", "3 h", "2 dygn". */
export function ageText(iso, nowMs = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '–';
  const sec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (sec < 60) return 'just nu';
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h`;
  return `${Math.floor(sec / 86400)} dygn`;
}

export const PAYOUT_STATUS = {
  complete: { label: 'Klar', tone: 'ok', help: 'Alla rader är avstämda och köade för bokföring.' },
  partial: { label: 'Delvis', tone: 'warn', help: 'Några rader väntar på åtgärd. Verifikatet skapas när alla rader är lösta.' },
  rejected: { label: 'Avvisad', tone: 'bad', help: 'Utbetalningen gick inte att lita på. Ingenting har bokförts.' },
};

export const COMMAND_STATUS = {
  pending: { label: 'Väntar', tone: 'neutral' },
  in_progress: { label: 'Pågår', tone: 'neutral' },
  succeeded: { label: 'Utförd', tone: 'ok' },
  failed: { label: 'Försöker igen', tone: 'warn' },
  dead: { label: 'Misslyckad, kräver åtgärd', tone: 'bad' },
};

export const EXCEPTION_STATUS = {
  open: { label: 'Öppen', tone: 'warn' },
  resolved: { label: 'Löst', tone: 'ok' },
  dismissed: { label: 'Avfärdad', tone: 'neutral' },
};

export const COMMAND_KIND = {
  register_invoice_payment: 'Inbetalning på faktura',
  credit_invoice: 'Kreditering av faktura',
  post_voucher: 'Verifikat',
};

/** Förklaring och rekommenderad åtgärd per avvikelsekod. Alla koder i ExceptionCode ska finnas här. */
export const EXCEPTION_INFO = {
  PAYOUT_SUM_MISMATCH: {
    title: 'Summan stämmer inte',
    meaning: 'Utbetalningens rader summerar inte till det belopp som betalats ut. Hela utbetalningen avvisades och inget har bokförts.',
    action: 'Kontrollera utbetalningen hos betalleverantören. Rättas den hämtas den om automatiskt.',
  },
  DUPLICATE_LINE_ID: {
    title: 'Samma rad-id två gånger',
    meaning: 'Två rader i utbetalningen har samma id. Utbetalningen avvisades.',
    action: 'Detta är ett fel hos leverantörens data. Kontakta leverantören.',
  },
  INVALID_AMOUNT: {
    title: 'Ogiltigt belopp',
    meaning: 'Ett belopp är negativt, har decimaler, är noll eller är för stort för att summeras säkert.',
    action: 'Kontrollera raden hos leverantören. Rättas den hämtas den om automatiskt.',
  },
  CURRENCY_MISMATCH: {
    title: 'Olika valutor',
    meaning: 'Raden och utbetalningen, eller raden och fakturan, har olika valuta. Flervaluta stöds inte ännu.',
    action: 'Bokför raden manuellt i affärssystemet och stäng avvikelsen med en anteckning.',
  },
  INVALID_PAYOUT: {
    title: 'Ogiltig utbetalning',
    meaning: 'Utbetalningen saknar id eller giltigt datum, en rad saknar referens eller har okänd typ.',
    action: 'Detta är ett fel hos leverantörens data. Kontakta leverantören.',
  },
  EMPTY_PAYOUT: {
    title: 'Tom utbetalning',
    meaning: 'Utbetalningen har inga rader.',
    action: 'Kontrollera hos leverantören. Normalt ingen åtgärd om utbetalningen verkligen är tom.',
  },
  DUPLICATE_INVOICE_ID: {
    title: 'Samma faktura-id två gånger',
    meaning: 'Affärssystemet returnerade samma faktura två gånger. Utbetalningen avvisades.',
    action: 'Kontakta den som driftar tjänsten. Det är ett fel i kopplingen till affärssystemet.',
  },
  NO_MATCH: {
    title: 'Ingen faktura hittades',
    meaning: 'Ingen faktura i affärssystemet har den här referensen, så betalningen kunde inte bokföras.',
    action: 'Finns fakturan inte ännu återupptas utbetalningen automatiskt när den dyker upp. Annars: bokför betalningen manuellt och stäng avvikelsen.',
  },
  AMBIGUOUS_MATCH: {
    title: 'Flera fakturor har samma referens',
    meaning: 'Det går inte att veta vilken faktura betalningen avser, så ingenting bokfördes.',
    action: 'Avgör vilken faktura det gäller, bokför manuellt och stäng avvikelsen med en anteckning.',
  },
  INVOICE_NOT_OPEN: {
    title: 'Fakturan är inte öppen',
    meaning: 'Fakturan är redan betald eller annullerad (eller, vid återbetalning, inte betald).',
    action: 'Kontrollera fakturan. Är det en dubblettbetalning ska den hanteras manuellt. Stäng sedan avvikelsen.',
  },
  AMOUNT_MISMATCH: {
    title: 'Beloppet stämmer inte',
    meaning: 'Betalningen motsvarar inte exakt fakturans obetalda belopp. Delbetalningar bokförs inte automatiskt.',
    action: 'Bokför betalningen manuellt (t.ex. som delbetalning) och stäng avvikelsen med en anteckning.',
  },
  REFUND_EXCEEDS_INVOICE: {
    title: 'Återbetalningen är för stor',
    meaning: 'Återbetalningen är större än det som återstår att kreditera på fakturan.',
    action: 'Kontrollera tidigare krediteringar och beloppet hos leverantören. Hantera manuellt.',
  },
  INVALID_INVOICE: {
    title: 'Fakturan har ogiltiga uppgifter',
    meaning: 'Fakturans belopp hänger inte ihop (t.ex. moms större än total).',
    action: 'Rätta fakturan i affärssystemet. Utbetalningen återupptas därefter automatiskt.',
  },
  COMMAND_CONFLICT: {
    title: 'Raden har ändrats efter att den köades',
    meaning: 'Leverantören har ändrat eller tagit bort en rad som redan köats för bokföring. Det köade kommandot behålls oförändrat.',
    action: 'Jämför med affärssystemet och avgör manuellt. Gissa inte.',
  },
  INTERNAL_IMBALANCE: {
    title: 'Internt fel i verifikatet',
    meaning: 'Verifikatet balanserade inte. Det ska aldrig hända. Inget verifikat skapades.',
    action: 'Kontakta den som driftar tjänsten direkt.',
  },
};

/** Beskriver ett kommando ur ett förslag på ett sätt som en människa kan granska. */
export function describeCommand(command) {
  const currency = command.currency ?? 'SEK';
  switch (command.kind) {
    case 'register_invoice_payment':
      return {
        title: COMMAND_KIND.register_invoice_payment,
        rows: [
          ['Faktura', command.invoiceId],
          ['Belopp', formatAmount(command.amount, currency)],
          ['Datum', command.date],
        ],
      };
    case 'credit_invoice':
      return {
        title: COMMAND_KIND.credit_invoice,
        rows: [
          ['Faktura', command.invoiceId],
          ['Typ', command.mode === 'full' ? 'Helkreditering' : 'Delkreditering'],
          ['Belopp', formatAmount(command.amount, currency)],
          ['varav netto', formatAmount(command.net, currency)],
          ['varav moms', formatAmount(command.vat, currency)],
          ['Datum', command.date],
        ],
      };
    case 'post_voucher':
      return {
        title: COMMAND_KIND.post_voucher,
        rows: [
          ['Text', command.description],
          ['Datum', command.date],
        ],
        voucher: command.lines ?? [],
      };
    default:
      return { title: String(command.kind), rows: [] };
  }
}

/** Kontrollsumma för ett verifikat. Allt i minsta enhet. */
export function voucherBalance(lines) {
  const debit = lines.reduce((sum, l) => sum + l.debit, 0);
  const credit = lines.reduce((sum, l) => sum + l.credit, 0);
  return { debit, credit, balanced: debit === credit };
}

export const PAGES = ['oversikt', 'start', 'forslag', 'utbetalningar', 'avvikelser', 'osakra'];

/** "#/forslag/UTB-1" -> { page: 'forslag', id: 'UTB-1' }. Okända sidor blir översikten. */
export function parseHash(hash) {
  const parts = String(hash || '')
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean);
  const page = PAGES.includes(parts[0]) ? parts[0] : 'oversikt';
  let id = null;
  // Ett id hör bara till en känd sida. En okänd sida blir översikten utan id.
  if (parts[1] && PAGES.includes(parts[0])) {
    try {
      id = decodeURIComponent(parts[1]);
    } catch {
      id = null;
    }
  }
  return { page, id };
}

/** Begriplig svensk text för ett API-fel. Läcker aldrig serverns råtext utöver dess felmeddelande. */
export function apiErrorMessage(status, body, retryAfterSec) {
  const serverMessage = body && body.error && typeof body.error.message === 'string' ? body.error.message : null;
  switch (status) {
    case 0:
      return 'Kunde inte nå servern. Kontrollera anslutningen och försök igen.';
    case 400:
      return serverMessage ? `Ogiltig begäran: ${serverMessage}` : 'Ogiltig begäran.';
    case 401:
      return 'API-nyckeln är ogiltig, återkallad eller utgången.';
    case 404:
      return 'Hittades inte. Den kan ha tagits bort eller tillhöra någon annan.';
    case 409:
      return serverMessage ? `Kunde inte genomföras: ${serverMessage}` : 'Kunde inte genomföras, någon annan kan redan ha hanterat den.';
    case 413:
      return 'Begäran är för stor.';
    case 429:
      return retryAfterSec ? `För många anrop. Vänta ${retryAfterSec} sekunder och försök igen.` : 'För många anrop. Vänta en stund och försök igen.';
    default:
      return status >= 500 ? 'Något gick fel hos servern. Försök igen om en stund.' : 'Något gick fel.';
  }
}

/** Fas i onboardingen: vad den betyder för användaren. */
export const ONBOARDING_PHASE = {
  setup: { label: 'Pågår', tone: 'warn', help: 'Något återstår innan förslagen kan godkännas.' },
  review: { label: 'Redo för granskning', tone: 'ok', help: 'Allt är på plats. Granska förslagen och godkänn när de stämmer.' },
  live: { label: 'Live', tone: 'ok', help: 'Kunden bokför på riktigt.' },
};

/** Valideringsfel (text) eller null för godkännande av go-live. Granskningen måste vara bekräftad. */
export function validateGoLive({ reviewed }) {
  if (reviewed !== true) return 'Bekräfta att du har granskat förslagen innan du godkänner.';
  return null;
}

/** Valideringsfel (text) eller null. Samma regler som API:t (1 till 2000 tecken efter trim). */
export function validateResolve({ status, note }) {
  if (status !== 'resolved' && status !== 'dismissed') return 'Välj hur avvikelsen ska stängas.';
  const trimmed = String(note ?? '').trim();
  if (trimmed.length === 0) return 'Skriv en anteckning om vad som gjorts. Den behövs för spårbarheten.';
  if (trimmed.length > 2000) return 'Anteckningen är för lång (högst 2000 tecken).';
  return null;
}

/** Valideringsfel (text) eller null för avgörande av osäkert utfall. */
export function validateGuardResolve({ applied, externalId }) {
  if (applied !== true && applied !== false) return 'Välj om kommandot utfördes eller inte.';
  const ext = String(externalId ?? '').trim();
  if (applied && ext.length === 0) return 'Ange id:t från affärssystemet (verifikatnummer eller liknande) när kommandot utfördes.';
  if (!applied && ext.length > 0) return 'Ange inget id när kommandot inte utfördes.';
  if (ext.length > 200) return 'Id:t är för långt.';
  return null;
}
