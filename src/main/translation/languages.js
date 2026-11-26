// Langues de la traduction intégrée et détection de la langue d'un texte.
// La détection est volontairement simple (alphabet + mots les plus fréquents) :
// elle sert à proposer la traduction, la langue peut toujours être corrigée
// à la main dans le menu du bouton « Traduire ».

const NAMES = {
  bg: 'bulgare',
  cs: 'tchèque',
  de: 'allemand',
  en: 'anglais',
  es: 'espagnol',
  et: 'estonien',
  fa: 'persan',
  fr: 'français',
  is: 'islandais',
  it: 'italien',
  nb: 'norvégien (bokmål)',
  nl: 'néerlandais',
  nn: 'norvégien (nynorsk)',
  pl: 'polonais',
  pt: 'portugais',
  ru: 'russe',
  uk: 'ukrainien',
};

const name = (code) => NAMES[code] || code;
const capitalized = (code) => {
  const n = name(code);
  return n.charAt(0).toUpperCase() + n.slice(1);
};

// « de l'anglais », « du français »
function fromName(code) {
  const n = name(code);
  return /^[aeiouéèêh]/i.test(n) ? `de l’${n}` : `du ${n}`;
}

// « en anglais », « en français »
const inName = (code) => `en ${name(code).replace(/ \(.*\)$/, '')}`;

const STOPWORDS = {
  en: 'the of and to in is that it for on with as are was this be by you not or have from at which but they his her we can will',
  fr: 'le la les de des du et est un une que qui dans pour pas sur au aux ce cette il elle sont avec par plus nous vous ne se',
  de: 'der die das und ist nicht ein eine zu den von mit sich des auf für im dem auch es sind wird werden ich sie oder wie',
  es: 'el la los las de que y en un una por con para es se del al lo como más pero sus está son le ya fue muy',
  it: 'il lo la gli le di che e è un una per con non sono del della al nel si come più anche questo ma ha alla dei',
  pt: 'o a os as de que e do da em um uma para com não por se dos das mais como foi são está ao ele mas tem',
  nl: 'de het een en van is dat op te in zijn niet met voor die er aan ook als bij maar wordt naar dit om je',
  pl: 'i w nie na się z do że to jest jak o co ale za od po tak dla są przez czy jego już może także',
  cs: 'a v se na je že to s z do o jako ale by jsou pro které jeho jak není nebo tak už ve také byl jsem',
  et: 'ja on ei et see oli ka kui mis ta ning aga või siis nii kõik ole seda selle mida veel ning nad mis',
  is: 'og að í á er sem til það ekki við um með var fyrir en af hann eru þetta sig hún ég þú',
  nb: 'og i det er på som en til at av for med ikke har de den var seg jeg men om fra kan hva hun',
  nn: 'og i det er på som ein til å av for med ikkje har dei den var seg eg men om frå kan kva ho',
};

const STOP_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

// Renvoie { lang, confident } ou null si le texte est trop court / ambigu.
function detect(text) {
  const sample = String(text || '').slice(0, 6000);
  const letters = sample.match(/\p{L}/gu) || [];
  if (letters.length < 3) return null;

  // Alphabets non latins
  const count = (re) => (sample.match(re) || []).length;
  const arabic = count(/[؀-ۿ]/g);
  const cyrillic = count(/[Ѐ-ӿ]/g);
  if (arabic > letters.length * 0.4) return { lang: 'fa', confident: letters.length > 15 };
  if (cyrillic > letters.length * 0.4) {
    const uk = count(/[іїєґІЇЄҐ]/g);
    const ru = count(/[ыэЫЭ]/g);
    const bg = count(/[ъЪ]/g);
    let lang = 'ru';
    if (uk > ru && uk >= bg) lang = 'uk';
    else if (bg > ru && bg > uk) lang = 'bg';
    return { lang, confident: letters.length > 15 && (uk + ru + bg) > 0 };
  }

  // Alphabet latin : mots fréquents
  const words = sample.toLowerCase().match(/\p{L}+/gu) || [];
  if (words.length === 0) return null;
  const scores = Object.entries(STOP_SETS).map(([lang, set]) => {
    let n = 0;
    for (const w of words) if (set.has(w)) n++;
    return { lang, n };
  }).sort((a, b) => b.n - a.n);
  const [best, second] = scores;
  if (best.n === 0) return null;
  const ratio = best.n / words.length;
  const confident = words.length >= 4 && ratio >= 0.08 && best.n >= 1.4 * second.n;
  return { lang: best.lang, confident: confident || (words.length < 4 && best.n > second.n) };
}

// Code de langue d'un attribut lang="…" (« en-US » -> « en », « no » -> « nb »)
function normalizeLangAttr(attr) {
  const code = String(attr || '').trim().toLowerCase().split(/[-_]/)[0];
  if (code === 'no') return 'nb';
  return code;
}

module.exports = { NAMES, name, capitalized, fromName, inName, detect, normalizeLangAttr };
