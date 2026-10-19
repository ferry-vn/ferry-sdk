/**
 * Shared fixtures (also imported by the CLI and MCP tests): a SuperDong-like
 * voyage with a one-floor seat map, prices and age-based ticket types.
 */
import type { BoatLayoutWithAdditions, Location, OperatorNational, Voyage } from '../src/index.js';

export const VOYAGE_ID = '66f0000000000000000000a1';

export const LOCATIONS = [
  { id: '66330d45f6e1ebe224e226a1', location_name: 'Phú Quốc', abbreviation: 'PQ', disable: false },
  { id: '66330d45f6e1ebe224e226a2', location_name: 'Rạch Giá', abbreviation: 'RG', disable: false },
] as unknown as Location[];

export const VOYAGE = {
  id: VOYAGE_ID,
  operator_id: 'OP1',
  operator: { id: 'OP1', operator_code: 'superdong', operator_name: 'Superdong' },
  route: { departure_name: 'Rạch Giá', destination_name: 'Phú Quốc' },
  // Far in the future so the builder's "already departed" check never trips.
  departure_date: '2036-10-20',
  depart_time: '08:00',
  boat_name: 'Superdong IX',
} as unknown as Voyage;

export const NATIONALS = [
  { national_id: '1', abbrev: 'VN', name: 'Việt Nam', default: true },
  { national_id: '2', abbrev: 'US', name: 'United States', default: false },
] as unknown as OperatorNational[];

export const LAYOUT = {
  additions: [],
  boatLayout: {
    id: 'BL1',
    voyage_id: VOYAGE_ID,
    seat_types: ['ECO', 'VIP'],
    floors: [
      {
        floor_id: 'F1',
        floor_name: 'Tầng 1',
        no_rows: 1,
        no_cols: 6,
        SeatIds: [11, 12, 13, 14, 15, 0],
        PositionIds: [101, 102, 103, 104, 105, 106],
        SeatNames: ['A1', 'A2', 'A3', 'A4', 'V1', ''],
        SeatTypes: ['ECO', 'ECO', 'ECO', 'ECO', 'VIP', ''],
        IsVIPs: [false, false, false, false, true, false],
        IsSeats: [true, true, true, true, true, false],
        IsBookeds: [false, true, false, false, false, false],
        IsHelds: [false, false, false, false, false, false],
        IsExporteds: [false, false, false, false, false, false],
        SortAutos: [1, 2, 3, 4, 5, 6],
        Rows: [1, 1, 1, 1, 1, 1],
        Cols: [1, 2, 3, 4, 5, 6],
      },
    ],
    prices: [
      {
        id: 5,
        ticket_type_id: 1,
        ticket_type_label: 'Người lớn',
        seat_type: 'ECO',
        original_price: 300000,
        price_with_VAT: 330000,
        is_default: true,
      },
      {
        id: 6,
        ticket_type_id: 4,
        ticket_type_label: 'Trẻ em',
        seat_type: 'ECO',
        original_price: 230000,
        price_with_VAT: 250000,
        is_default: false,
      },
      {
        id: 7,
        ticket_type_id: 2,
        ticket_type_label: 'Người cao tuổi',
        seat_type: 'ECO',
        original_price: 250000,
        price_with_VAT: 280000,
        is_default: false,
      },
      {
        id: 8,
        ticket_type_id: 1,
        ticket_type_label: 'Người lớn',
        seat_type: 'VIP',
        original_price: 450000,
        price_with_VAT: 500000,
        is_default: true,
      },
    ],
    ticket_type_configs: [
      { ticket_type_id: 1, ticket_type_label: 'Người lớn', key_config: 'MIN_AGE', value_config: '12', note: '' },
      { ticket_type_id: 1, ticket_type_label: 'Người lớn', key_config: 'MAX_AGE', value_config: '59', note: '' },
      { ticket_type_id: 4, ticket_type_label: 'Trẻ em', key_config: 'MIN_AGE', value_config: '1', note: '' },
      { ticket_type_id: 4, ticket_type_label: 'Trẻ em', key_config: 'MAX_AGE', value_config: '11', note: '' },
      { ticket_type_id: 2, ticket_type_label: 'Người cao tuổi', key_config: 'MIN_AGE', value_config: '60', note: '' },
    ],
  },
} as unknown as BoatLayoutWithAdditions;

export const ADULT = {
  name: 'Nguyen Van A',
  dateOfBirth: '1990-05-01',
  socialId: '079090000001',
  homeTown: 'Cần Thơ',
  gender: 'male' as const,
};
export const CHILD = {
  name: 'Nguyen Van B',
  dateOfBirth: '2018-03-02',
  socialId: '079090000001',
  homeTown: 'Cần Thơ',
  gender: 'male' as const,
};
export const ELDER = {
  name: 'Tran Thi C',
  dateOfBirth: '1950-01-01',
  socialId: '079050000003',
  homeTown: 'Cần Thơ',
  gender: 'female' as const,
};
