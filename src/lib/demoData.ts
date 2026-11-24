import type { Extraction } from "../types";

export interface SampleLetter {
  id: string;
  label: string;
  text: string;
  /** Plausible extraction variants, used to simulate k-sample disagreement in mock mode. */
  variants: Extraction[];
}

export const SAMPLE_LETTERS: SampleLetter[] = [
  {
    id: "denial",
    label: "Insurance denial",
    text: `Northwind Health — Claims Department
PO Box 4412, Springfield

Dear Ms. A. Okafor,

RE: Claim 88-4419-02    Policy 4021-7788-1
Date of service: 2026-10-02

We have completed our review and are unable to approve the claim referenced above.
The service was billed as out-of-network. You may request an internal review within
60 days of the date of this letter. Appeals must be received by 2027-01-19.

To appeal, send a written statement and the itemised bill to the address above,
or fax it to +1 (555) 010-4477. Please quote claim 88-4419-02 on every page.

Sincerely,
Claims Review Team`,
    variants: [
      {
        documentType: "denial",
        deadline: "2027-01-19",
        actions: [
          "Send a written appeal statement to the claims address.",
          "Attach the itemised bill to the appeal.",
        ],
        references: ["Claim 88-4419-02", "Policy 4021-7788-1", "+1 (555) 010-4477"],
      },
      {
        documentType: "denial",
        deadline: "2027-01-19",
        actions: [
          "Send a written appeal to the claims address.",
          "Include the itemised bill with the appeal.",
        ],
        references: ["Claim 88-4419-02", "Policy 4021-7788-1"],
      },
      {
        documentType: "denial",
        deadline: "2027-01-09",
        actions: [
          "Request an internal review in writing.",
          "Attach the itemised bill to the appeal.",
        ],
        references: ["Claim 88-4419-02", "Policy 4021-7788-1", "+1 (555) 010-4477"],
      },
    ],
  },
  {
    id: "lease",
    label: "Lease addendum",
    text: `Harbour Lettings
12 Quay Street

Dear Tenant,

Re: Flat 3, 44 Bridge Road — tenancy 2026/114

This addendum varies clause 7 of your tenancy agreement. Rent will increase by 4.2%
from 2027-02-01. You must confirm acceptance in writing by 2026-12-15. If we do not
receive your written acceptance by that date, the variation will not take effect and
the existing rent continues.

Send confirmation to tenant@harbour-lettings.example or by post to the address above.
Quote tenancy reference 2026/114.

Harbour Lettings`,
    variants: [
      {
        documentType: "lease",
        deadline: "2026-12-15",
        actions: ["Confirm acceptance of the rent variation in writing."],
        references: ["Tenancy 2026/114", "Flat 3, 44 Bridge Road"],
      },
      {
        documentType: "lease",
        deadline: "2026-12-15",
        actions: ["Confirm acceptance in writing before the deadline."],
        references: ["Tenancy 2026/114"],
      },
      {
        documentType: "lease",
        deadline: "2027-02-01",
        actions: ["Confirm acceptance of the rent variation in writing."],
        references: ["Tenancy 2026/114", "Flat 3, 44 Bridge Road"],
      },
    ],
  },
];

export function pickSample(text: string): SampleLetter {
  const haystack = text.toLowerCase();
  if (haystack.includes("tenan") || haystack.includes("rent")) return SAMPLE_LETTERS[1];
  return SAMPLE_LETTERS[0];
}
