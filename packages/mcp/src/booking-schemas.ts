/**
 * Booking input shared by quote_booking (read-only) and create_booking (write).
 */
import {
  type BookingDraft,
  type DraftLegSummary,
  type DraftPassenger,
  FerryBookingDraftError,
  type FerryClient,
  formatVnd,
} from '@ferryvn/sdk';
import { z } from 'zod';
import { ToolInputError } from './tool-helpers.js';

const passengerSchema = z
  .object({
    name: z.string().min(1).describe('Full name as on ID card / passport'),
    date_of_birth: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('YYYY-MM-DD'),
    social_id: z.string().min(1).describe('CCCD/CMND number (Vietnamese) or passport number (foreigner)'),
    home_town: z
      .string()
      .min(1)
      .describe('Home town / province, short (operators accept about 3–15 characters, e.g. "TP.HCM", "Cần Thơ")'),
    gender: z.enum(['male', 'female']).optional(),
    national_id: z
      .union([z.string(), z.number()])
      .optional()
      .describe('Nationality as ISO code ("US", "KR") or the operator’s national_id; omit for Vietnamese passengers'),
    ticket_type_id: z.number().int().optional().describe('Force a ticket type; omit to choose it from the age rules'),
    plate_number: z.string().optional().describe('Vehicle plate, only when travelling with a vehicle'),
    passport_expired_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('YYYY-MM-DD, foreign adults on some operators'),
  })
  .strict();

const legSchema = z
  .object({
    voyage_id: z.string().min(1).describe('voyage_id from search_voyages'),
    seats: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Seats exactly as listed by get_seat_map (e.g. "A1", or "C23#25" where names repeat), one per passenger in order; omit to auto-pick adjacent free seats of the cheapest seat type',
      ),
    seat_type: z.string().optional().describe('When auto-picking, only this seat type (e.g. "VIP")'),
    voucher_codes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const bookingInputShape = {
  customer_id: z.number().int().positive().describe('Numeric id of an existing customer of the organization'),
  orderer_name: z.string().min(1).describe('Name of the person placing the order'),
  contact_email: z.string().email(),
  phone_number: z.string().optional().describe('Mobile number of the orderer'),
  passengers: z.array(passengerSchema).min(1).max(50),
  depart: legSchema.describe('Outbound voyage'),
  return: legSchema.optional().describe('Optional return voyage (same passengers)'),
};

type BookingArgs = z.infer<z.ZodObject<typeof bookingInputShape>>;

const toPassenger = (p: z.infer<typeof passengerSchema>): DraftPassenger => ({
  name: p.name,
  dateOfBirth: p.date_of_birth,
  socialId: p.social_id,
  homeTown: p.home_town,
  gender: p.gender,
  nationalId: p.national_id,
  ticketTypeId: p.ticket_type_id,
  plateNumber: p.plate_number ?? null,
  passportExpiredAt: p.passport_expired_at ?? null,
});

/** Validate + price the booking (read-only calls); draft problems become a ToolInputError the model can fix. */
export async function prepareDraft(
  sdk: FerryClient,
  args: BookingArgs,
): Promise<{ draft: BookingDraft; passengers: DraftPassenger[] }> {
  const passengers = args.passengers.map(toPassenger);
  const leg = (l: z.infer<typeof legSchema>) => ({
    voyageId: l.voyage_id,
    seats: l.seats,
    seatType: l.seat_type,
    passengers,
    voucherCodes: l.voucher_codes,
  });
  try {
    const draft = await sdk.bookingDrafts.prepare({
      customerId: args.customer_id,
      ordererName: args.orderer_name,
      contactEmail: args.contact_email,
      phoneNumber: args.phone_number,
      depart: leg(args.depart),
      ...(args.return ? { return: leg(args.return) } : {}),
    });
    return { draft, passengers };
  } catch (e) {
    if (e instanceof FerryBookingDraftError) throw new ToolInputError(e.message);
    throw e;
  }
}

/** Human-readable summary used in confirmations: seats, ticket types, prices and the total. */
export function describeDraft(draft: BookingDraft): string {
  const leg = (l: DraftLegSummary) =>
    `${l.route ?? l.voyageId} ${l.departure ?? ''}: ${l.tickets
      .map((t) => `${t.passenger} seat ${t.seatName} (${t.ticketType}, ${formatVnd(t.priceVnd)})`)
      .join('; ')}`;
  const parts = [`tickets ${formatVnd(draft.estimatedTicketTotalVnd)}`];
  if (draft.estimatedHarborFeeVnd) parts.push(`harbor fees ${formatVnd(draft.estimatedHarborFeeVnd)}`);
  if (draft.estimatedVoucherDiscountVnd) parts.push(`vouchers −${formatVnd(draft.estimatedVoucherDiscountVnd)}`);
  const legs = [draft.depart, draft.return].filter((l): l is DraftLegSummary => l !== undefined).map(leg);
  return `${legs.join(' | ')}. Estimated total ${formatVnd(draft.estimatedTotalVnd)} (${parts.join(', ')}).`;
}

/** Structured quote returned by quote_booking. */
export function quoteOf(draft: BookingDraft) {
  const leg = (l: DraftLegSummary) => ({
    voyage_id: l.voyageId,
    route: l.route,
    departure: l.departure,
    operator: l.operatorCode,
    tickets: l.tickets.map((t) => ({
      passenger: t.passenger,
      seat: t.seatName,
      seat_ref: t.seatRef,
      seat_type: t.seatType,
      ticket_type_id: t.ticketTypeId,
      ticket_type: t.ticketType,
      price_vnd: t.priceVnd,
      harbor_fee_vnd: t.harborFeeVnd,
    })),
    vouchers: l.vouchers,
    total_vnd: l.totalVnd,
  });
  return {
    depart: leg(draft.depart),
    ...(draft.return ? { return: leg(draft.return) } : {}),
    ticket_total_vnd: draft.estimatedTicketTotalVnd,
    harbor_fee_vnd: draft.estimatedHarborFeeVnd,
    voucher_discount_vnd: draft.estimatedVoucherDiscountVnd,
    estimated_total_vnd: draft.estimatedTotalVnd,
    warnings: draft.warnings,
  };
}
