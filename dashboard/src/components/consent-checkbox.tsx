'use client';

// Click-wrap consent checkbox shared by every signup surface (landing card,
// /welcome/start, /login signup tab incl. invite joins). Checking it is what
// lets the form submit; the value travels to the gateway as `acceptTerms`,
// which records the accepted legal-document versions + timestamp per tenant
// (core/legal.ts) and is REQUIRED there when LEGAL_CONSENT_REQUIRED=1.
import Link from 'next/link';

export function ConsentCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        required
        className="mt-0.5 accent-teal-500"
      />
      <span className="text-xs text-[rgb(var(--text-muted))] leading-relaxed">
        I agree to the{' '}
        <Link href="/terms" target="_blank" className="text-teal-400 hover:text-teal-300 underline">
          Terms of Service
        </Link>
        ,{' '}
        <Link href="/privacy" target="_blank" className="text-teal-400 hover:text-teal-300 underline">
          Privacy Policy
        </Link>{' '}
        and{' '}
        <Link href="/acceptable-use" target="_blank" className="text-teal-400 hover:text-teal-300 underline">
          Acceptable Use Policy
        </Link>
        .
      </span>
    </label>
  );
}
