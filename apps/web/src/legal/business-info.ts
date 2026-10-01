import { PAYMENT_REFUND_WINDOW_DAYS } from '@buddha/shared';
import { copy } from '@/copy';
import { fillTemplate } from './template';

/** What a fact the owner has not supplied yet reads as, everywhere it is shown (ADR-0044). */
export const UNDECIDED = '미정';

/**
 * Every business fact the footer and the three legal pages print, in ONE place (owner decision
 * 2026-09-28 §7). The prose never repeats a value: it writes `{{companyName}}`, and
 * `fillTemplate` substitutes it at render time, so filling in the real 상호 is a one-line edit
 * here that reaches the footer, 이용약관, 개인정보처리방침 and 환불정책 at once.
 *
 * The first group is what the owner still has to supply (docs/QUESTIONS.md, PG section); each
 * reads `미정` until then. The second group is already decided and only lives here so the
 * legal text can name it the same way — the service name comes from `copy`, the refund window
 * from the constant the API's refund check uses, so neither can drift from the code.
 *
 * Values are plain text, never markup; a value may not be empty (the unit tests pin that).
 * The prose never puts a particle whose form depends on the last syllable (이/가, 은/는, 을/를,
 * 과/와, 로/으로) straight after a placeholder — `미정` and the real 상호 need different ones — so
 * it writes `회사(상호: {{companyName}}, 이하 "회사")가` and lets the particle follow `회사`.
 */
export const BUSINESS_INFO = {
  // --- owner to supply ---
  /** 상호 (법인명 또는 개인사업자 상호). */
  companyName: UNDECIDED,
  /** 대표자 성명. */
  ceoName: UNDECIDED,
  /** 사업자등록번호. */
  businessNumber: UNDECIDED,
  /** 통신판매업 신고번호. */
  mailOrderNumber: UNDECIDED,
  /** 사업장 소재지. */
  address: UNDECIDED,
  /** 고객센터 전화번호. */
  phone: UNDECIDED,
  /** 고객 문의·환불 요청을 받는 이메일 주소. */
  email: UNDECIDED,
  /** 개인정보 보호책임자 (성명 또는 직책). */
  privacyOfficer: UNDECIDED,
  /** 개인정보 보호책임자 연락 이메일. */
  privacyOfficerEmail: UNDECIDED,
  /** P 유효기간 — the whole phrase, e.g. "충전일로부터 5년" (open question, QUESTIONS.md). */
  pointExpiry: UNDECIDED,
  /**
   * 환불 요청 처리 기한 — the whole phrase, e.g. "요청을 받은 날부터 영업일 기준 1일 이내". The
   * refund window is judged when the admin processes the refund, so this is how long a member
   * has to allow for.
   */
  refundProcessingTime: UNDECIDED,
  /** 약관·방침 시행일, e.g. "2026년 10월 1일". */
  effectiveDate: UNDECIDED,

  // --- decided ---
  serviceName: copy.appName,
  /** 결제대행사 (ADR-0042). */
  pgName: '스마트로(주)',
  pgServiceName: '스마트로페이(SmartroPay)',
  /** terraform/: every resource in ap-northeast-2, mail through Amazon SES in the same region. */
  hostingProvider: 'Amazon Web Services, Inc.',
  hostingRegion: '아시아 태평양(서울) 리전',
  /** 가입 가능 최소 연령 (만 나이). */
  minimumAge: '14',
  /** 청약철회 기간 in days — the API's `PAYMENT_REFUND_WINDOW_DAYS` (owner decision §5). */
  refundWindowDays: String(PAYMENT_REFUND_WINDOW_DAYS),
} as const satisfies Record<string, string>;

export type BusinessInfoKey = keyof typeof BUSINESS_INFO;

/** The keys the owner still has to fill in; the tests check each one is present. */
export const OWNER_SUPPLIED_KEYS = [
  'companyName',
  'ceoName',
  'businessNumber',
  'mailOrderNumber',
  'address',
  'phone',
  'email',
  'privacyOfficer',
  'privacyOfficerEmail',
  'pointExpiry',
  'refundProcessingTime',
  'effectiveDate',
] as const satisfies readonly BusinessInfoKey[];

/** `text` with its `{{placeholders}}` filled from `BUSINESS_INFO` (throws on an unknown key). */
export function fillBusinessInfo(text: string): string {
  return fillTemplate(text, BUSINESS_INFO);
}

/**
 * The footer's 사업자 정보 lines in display order (「전자상거래 등에서의 소비자보호에 관한 법률」
 * 제10조: 상호, 대표자, 주소, 연락처, 사업자등록번호 and the rest a 사이버몰 must show), as the
 * `copy` templates the footer fills.
 */
export const FOOTER_BUSINESS_LINES = [
  copy.footerCompany,
  copy.footerCeo,
  copy.footerBusinessNumber,
  copy.footerMailOrderNumber,
  copy.footerAddress,
  copy.footerPhone,
  copy.footerEmail,
  copy.footerPrivacyOfficer,
  copy.footerHosting,
] as const;
