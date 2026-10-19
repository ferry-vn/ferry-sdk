/**
 * Backend domain error codes (`FerryApiError.errorCode`), from backend v3.2.16
 * enums: operators 11xxxx, bookings 12xxxx, customers 13xxxx, organizations
 * 14xxxx, orders & vouchers 15xxxx, cancel-ticket requests 16xxxx.
 *
 * @example
 *   if (e instanceof FerryApiError && e.errorCode === FerryErrorCode.OrganizationBalanceNotEnough) { ... }
 */
export const FerryErrorCode = {
  // ── Operators (ferry companies' systems) ──
  OperatorUnhandledException: 110000,
  OperatorCannotLogin: 110101,
  OperatorAuthFailed: 110102,
  OperatorCannotGetAgentInfo: 110105,
  OperatorPayloadInvalid: 110201,
  OperatorUnavailableSeats: 110205,
  OperatorBalanceNotEnough: 110210,
  OperatorDuplicateSocialId: 110215,
  OperatorSocialIdAlreadyPlacedOrder: 110216,
  OperatorUnknownErrorWhenCreateOrder: 110290,
  OperatorUnknownErrorWhenExportTicket: 110291,
  OperatorTicketNotFound: 110292,
  OperatorOrderNotFound: 110293,
  OperatorTicketsNotSameTypes: 110294,
  OperatorVoyageDisabledOrOutOfSeat: 110295,
  OperatorApiTimeout: 110296,
  OperatorVoyageNoLongerAvailable: 110297,
  OperatorIsDisabled: 110301,
  // ── Bookings ──
  BookingUnknown: 120000,
  AlreadyProcessingIssueTicket: 120100,
  CustomerBalanceNotEnough: 120101,
  BookingInvalidInput: 120105,
  BookingInvalidStatus: 120110,
  NoCustomerAttached: 120115,
  OrganizationBalanceNotEnough: 120120,
  NotAllowedToBookSeriTickets: 120125,
  RequesterNotExisted: 120130,
  MaxRetriesReached: 120135,
  RetryCooldown: 120140,
  BookingBalanceInvalidInput: 120201,
  BookingBalanceNotEnough: 120205,
  // ── Customers ──
  CustomerNotFound: 130102,
  CustomerInvalidAmount: 130103,
  InvalidNumberOfOrderDebts: 130120,
  CustomerBalanceUpdateFailed: 130200,
  CustomerInvalidInput: 130201,
  CustomerWalletBalanceNotEnough: 130205,
  CustomerReservationNotEnough: 130206,
  DepositToUnknownBooking: 130210,
  // ── Organizations ──
  OrgBalanceNotEnough: 140101,
  OrganizationNotFound: 140102,
  OrganizationInvalidAmount: 140103,
  OrganizationBalanceUpdateFailed: 140200,
  OrganizationInvalidInput: 140201,
  OrganizationUpwardBalanceNotEnough: 140205,
  // ── Orders & vouchers ──
  OrderUnknown: 150000,
  OrderInvalidInput: 150101,
  OrderInvalidStatus: 150102,
  DuplicateSocialId: 150105,
  InvalidTicketTypeId: 150107,
  InvalidSeatType: 150108,
  NoPriceMatched: 150109,
  DiscountMinValue: 150111,
  DiscountPercentMaxValue: 150115,
  VoucherMinValue: 150117,
  NotEnoughSeriTickets: 150120,
  VoucherPercentMaxValue: 150121,
  DuplicateVoucherApplied: 150123,
  VoucherNotExist: 150125,
  VoucherNotApplicable: 150127,
  UniqueVoucherRuleSpoiled: 150129,
  VoucherCodeAlreadyExists: 150131,
  VoucherLimitPerCustomerExceeded: 150133,
  UnavailableSeats: 150201,
  // ── Cancel-ticket requests ──
  CancelUnknown: 160000,
  CancelOrderIdNotExist: 160101,
  CancelOrderNotBooked: 160102,
  CancelOrganizationIdNotExist: 160103,
  CancelTicketsSettingEmpty: 160104,
  CancelBalanceNotEnough: 160105,
  CancelOrderIdEmpty: 160106,
  CancelTicketsEmpty: 160107,
  CancelReasonEmpty: 160108,
  CancelOrganizationNotExists: 160109,
  VoyageDepartTimeMissing: 160110,
  VoyageDepartTimeInvalid: 160111,
  VoyageAlreadyDeparted: 160112,
  RelatedOrgEmpty: 160113,
  CalculateRefundProblem: 160114,
  CancelTicketRulesEmpty: 160120,
  CancelCustomerNotExists: 160124,
  OperatorCodeNotExists: 160125,
  CancelTicketRequestRecalled: 160140,
  CancelTicketWithDiscount: 160141,
  DuplicatePositionId: 160142,
  NotAllowToRequestInTimeFrame: 160143,
  CannotFindCancelTicketRule: 160134,
} as const;
export type FerryErrorCode = (typeof FerryErrorCode)[keyof typeof FerryErrorCode];

const NAMES = new Map<number, string>(Object.entries(FerryErrorCode).map(([k, v]) => [v, k]));

/** Name of a known domain error code (e.g. `120120` → `"OrganizationBalanceNotEnough"`), else `undefined`. */
export function errorCodeName(code: number | undefined): string | undefined {
  return code === undefined ? undefined : NAMES.get(code);
}
