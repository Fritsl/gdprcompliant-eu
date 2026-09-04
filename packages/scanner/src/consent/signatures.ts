import type { ConsentPlatform } from '@gc/contracts';

// How the common consent platforms give themselves away in the DOM, and where their
// refusal lives. A signature names the banner's root, and, where the platform has one,
// the direct reject control and the settings control. Anything not matched here goes
// through the heuristic in banner.ts, which reads button text in the languages the
// product speaks.

export interface PlatformSignature {
  readonly platform: Exclude<ConsentPlatform, 'generic'>;
  readonly root: readonly string[];
  readonly reject?: readonly string[];
  readonly accept?: readonly string[];
  readonly settings?: readonly string[];
  readonly save?: readonly string[];
}

export const PLATFORM_SIGNATURES: readonly PlatformSignature[] = [
  {
    platform: 'cookiebot',
    root: ['#CybotCookiebotDialog', '#CookiebotWidget'],
    accept: [
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      '#CybotCookiebotDialogBodyButtonAccept',
    ],
    reject: [
      '#CybotCookiebotDialogBodyButtonDecline',
      '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
    ],
    settings: ['#CybotCookiebotDialogBodyLevelButtonCustomize'],
    save: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowallSelection'],
  },
  {
    platform: 'onetrust',
    root: ['#onetrust-banner-sdk', '#onetrust-consent-sdk'],
    accept: ['#onetrust-accept-btn-handler'],
    reject: ['#onetrust-reject-all-handler'],
    settings: ['#onetrust-pc-btn-handler'],
    save: ['.save-preference-btn-handler', '.onetrust-close-btn-handler'],
  },
  {
    platform: 'usercentrics',
    root: ['#usercentrics-root', '#usercentrics-cmp-ui'],
    accept: ['[data-testid="uc-accept-all-button"]'],
    reject: ['[data-testid="uc-deny-all-button"]'],
    settings: ['[data-testid="uc-more-button"]', '[data-testid="uc-customize-button"]'],
    save: ['[data-testid="uc-save-button"]'],
  },
  {
    platform: 'cookieinformation',
    root: ['#coiOverlay', '#coi-banner-wrapper'],
    reject: ['#declineButton', '.coi-banner__decline'],
    settings: ['#coi-banner-wrapper .coi-banner__toggle', '.coi-banner__show-details'],
    save: ['#coi-consent-banner__accept-selected', '.coi-banner__accept'],
  },
  {
    platform: 'didomi',
    root: ['#didomi-host', '#didomi-popup'],
    reject: ['#didomi-notice-disagree-button', '.didomi-continue-without-agreeing'],
    settings: ['#didomi-notice-learn-more-button'],
    save: ['.didomi-consent-popup-actions button'],
  },
  {
    platform: 'quantcast',
    root: ['.qc-cmp2-container', '#qc-cmp2-container'],
    reject: ['.qc-cmp2-summary-buttons button[mode="secondary"]'],
    settings: ['.qc-cmp2-summary-buttons button[mode="secondary"]'],
    save: ['.qc-cmp2-footer button[mode="primary"]'],
  },
  {
    platform: 'klaro',
    root: ['.klaro', '#klaro'],
    reject: ['.klaro .cm-btn-decline', '.klaro .cn-decline'],
    settings: ['.klaro .cm-btn-learn-more', '.klaro .cn-learn-more'],
    save: ['.klaro .cm-btn-accept', '.klaro .cn-buttons .cm-btn-success'],
  },
  {
    platform: 'cookieyes',
    root: ['.cky-consent-container', '#cookieyes'],
    reject: ['.cky-btn-reject'],
    settings: ['.cky-btn-customize'],
    save: ['.cky-btn-preferences'],
  },
  {
    platform: 'trustarc',
    root: ['#truste-consent-track', '#consent_blackbar'],
    reject: ['#truste-consent-required'],
    settings: ['#truste-show-consent'],
  },
  {
    platform: 'complianz',
    root: ['#cmplz-cookiebanner-container', '.cmplz-cookiebanner'],
    reject: ['.cmplz-deny'],
    settings: ['.cmplz-manage-options', '.cmplz-view-preferences'],
    save: ['.cmplz-save-preferences'],
  },
];

// Button text that means "no", "let me choose" and "keep what I chose", in the languages
// the product speaks. Matched on the control's visible text, lower-cased and trimmed.
export const REJECT_TEXT = [
  /^(afvis|afvis alle|afvis alt|nej tak|kun nødvendige|kun nødvendige cookies|tillad kun nødvendige|accepter kun nødvendige)$/,
  /^(reject|reject all|decline|decline all|refuse|refuse all|deny|deny all|no thanks|only necessary|necessary only|essential only|only essential|use necessary cookies only|accept only necessary)$/,
  /^(ablehnen|alle ablehnen|nur notwendige|nur erforderliche|nur notwendige cookies|nur essenzielle|nein danke)$/,
];

export const ACCEPT_TEXT = [
  /^(accepter|accepter alle|accepter alt|tillad alle|tillad alt|ok|okay|jeg accepterer|ja tak|godkend|godkend alle)$/,
  /^(accept|accept all|accept all cookies|allow all|allow all cookies|agree|i agree|got it|ok|okay|yes|accept cookies)$/,
  /^(akzeptieren|alle akzeptieren|allen zustimmen|zustimmen|ich stimme zu|einverstanden|alle cookies akzeptieren|ok)$/,
];

export const SETTINGS_TEXT = [
  /^(indstillinger|cookieindstillinger|tilpas|tilpas valg|administrer|administrér|vælg selv|detaljer|vis detaljer|flere valg)$/,
  /^(settings|cookie settings|manage|manage settings|manage preferences|manage cookies|preferences|customise|customize|more options|options|let me choose|show details|details|configure)$/,
  /^(einstellungen|cookie-einstellungen|anpassen|auswahl anpassen|mehr optionen|einstellungen verwalten|details|details anzeigen|konfigurieren)$/,
];

export const SAVE_TEXT = [
  /^(gem|gem indstillinger|gem valg|gem mine valg|bekræft valg|bekræft)$/,
  /^(save|save settings|save preferences|save my choices|save choices|confirm my choices|confirm choices|confirm|apply|done)$/,
  /^(speichern|auswahl speichern|einstellungen speichern|auswahl bestätigen|bestätigen|übernehmen)$/,
];

// Words that mark a banner when no signature does.
export const BANNER_WORDS =
  /cookie|cookies|samtykke|consent|privatliv|privacy|datenschutz|zustimm|einwilligung|sporing|tracking/i;

export const matches = (text: string, patterns: readonly RegExp[]): boolean => {
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return patterns.some((p) => p.test(t));
};
