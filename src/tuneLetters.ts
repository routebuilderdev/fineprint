import type { Extraction } from "./types";

export interface TuneLetter {
  id: string;
  text: string;
  /** What a careful human would write down. Used only to judge the majority answer. */
  truth: Extraction;
}

/** Six synthetic letters with unambiguous ground truth. No real personal data. */
export const TUNE_LETTERS: TuneLetter[] = [
  {
    id: "denial",
    text: `Northwind Health — Claims Department
PO Box 4412, Springfield

RE: Claim 88-4419-02    Policy 4021-7788-1
Date of service: 2026-10-02

We are unable to approve the claim referenced above. The service was billed as
out-of-network. You may request an internal review within 60 days. Appeals must be
received by 2027-01-19. Send a written statement and the itemised bill to the address
above, or fax +1 (555) 010-4477. Please quote claim 88-4419-02 on every page.`,
    truth: {
      documentType: "denial",
      deadline: "2027-01-19",
      actions: ["Send a written statement", "Send the itemised bill"],
      references: ["88-4419-02", "4021-7788-1"],
    },
  },
  {
    id: "lease",
    text: `Harbour Lettings
12 Quay Street

Re: Flat 3, 44 Bridge Road — tenancy 2026/114

This addendum varies clause 7 of your tenancy agreement. Rent will increase by 4.2%
from 2027-02-01. You must confirm acceptance in writing by 2026-12-15. If we do not
receive your written acceptance by that date, the variation will not take effect.

Send confirmation to tenant@harbour-lettings.example. Quote tenancy reference 2026/114.`,
    truth: {
      documentType: "lease",
      deadline: "2026-12-15",
      actions: ["Confirm acceptance in writing"],
      references: ["2026/114"],
    },
  },
  {
    id: "bill",
    text: `St. Alder Hospital — Patient Accounts
900 Ridgeway, Suite 200

Invoice INV-77321    Account 441-2290
Date of service: 2026-11-02

Your balance of $412.60 is due by 2026-12-08. Payment received after that date may be
referred to collections. If you believe this bill is wrong, you must dispute it in
writing within 30 days of the statement date.

Pay online at the patient portal or post a cheque quoting invoice INV-77321.`,
    truth: {
      documentType: "bill",
      deadline: "2026-12-08",
      actions: ["Pay the balance", "Dispute in writing if wrong"],
      references: ["INV-77321", "441-2290"],
    },
  },
  {
    id: "tax",
    text: `Revenue Office — Assessment Notice
Reference CP-5012-88

Your return for the year ended 2026-04-05 has been assessed. The amount payable is
$1,284.00 and must reach us by 2027-01-31. Interest accrues daily after that date.

If you disagree with this assessment, file a formal objection within 30 days of this
notice. Quote reference CP-5012-88 on all correspondence and payments.`,
    truth: {
      documentType: "tax",
      deadline: "2027-01-31",
      actions: ["Pay the amount due", "File a formal objection if you disagree"],
      references: ["CP-5012-88"],
    },
  },
  {
    id: "benefit",
    text: `County Benefits Office
Recertification Unit

Case: BX-2210-4471

Your household must complete a recertification interview by 2026-11-30. If the
interview is not completed by that date, benefits will stop on 2026-12-31 and a new
application will be required.

Call 555-0142 to book the interview, or attend the office with photo identification.
Bring proof of income for October 2026. Quote case BX-2210-4471.`,
    truth: {
      documentType: "benefit",
      deadline: "2026-11-30",
      actions: ["Complete the recertification interview", "Bring proof of income"],
      references: ["BX-2210-4471", "555-0142"],
    },
  },
  {
    id: "fine",
    text: `City Parking Enforcement
Penalty Notice PK-448120

Vehicle observed in a resident bay without a valid permit on 2026-11-11 at 14:22.

You must pay the penalty of $85 by 2026-12-04, or contest this notice in writing
before that date. Payment or written contest must be received by the address below,
not merely posted, by the deadline.

Quote penalty notice number PK-448120 with any payment or correspondence.`,
    truth: {
      documentType: "fine",
      deadline: "2026-12-04",
      actions: ["Pay the penalty", "Contest the notice in writing"],
      references: ["PK-448120"],
    },
  },
];
