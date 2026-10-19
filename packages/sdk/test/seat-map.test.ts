import { describe, expect, it } from 'vitest';
import { type BoatLayoutWithAdditions, flattenSeatMap } from '../src/index.js';

describe('flattenSeatMap', () => {
  it('turns parallel floor arrays into seats and counts availability', () => {
    const layout = {
      additions: [],
      boatLayout: {
        id: 'BL1',
        voyage_id: 'V1',
        seat_types: ['ECO'],
        prices: [],
        ticket_type_configs: [],
        floors: [
          {
            floor_id: 'F1',
            floor_name: 'Tầng 1',
            no_cols: 3,
            no_rows: 1,
            SeatIds: [11, 0, 13],
            SeatNames: ['A1', '', 'A3'],
            SeatTypes: ['ECO', '', 'VIP'],
            PositionIds: [101, 0, 103],
            SortAutos: [1, 0, 3],
            Rows: [1, 1, 1],
            Cols: [1, 2, 3],
            IsSeats: [true, false, true],
            IsBookeds: [false, false, true],
            IsHelds: [false, false, false],
            IsExporteds: [false, false, false],
            IsVIPs: [false, false, true],
          },
        ],
      },
    } as unknown as BoatLayoutWithAdditions;
    const map = flattenSeatMap(layout);
    expect(map.voyageId).toBe('V1');
    expect(map.total).toBe(2);
    expect(map.available).toBe(1);
    expect(map.floors).toEqual([{ floorId: 'F1', floorName: 'Tầng 1', total: 2, available: 1 }]);
    expect(map.seats[0]).toMatchObject({ seatName: 'A1', positionId: 101, seatId: 11, available: true });
    expect(map.seats[1]).toMatchObject({ seatName: 'A3', isBooked: true, isVip: true, available: false });
  });

  it('handles a missing layout', () => {
    expect(flattenSeatMap(null)).toMatchObject({ total: 0, available: 0, seats: [] });
  });
});

import { FerryClient, normalizeText } from '../src/index.js';
import { json, mockFetch } from './mock-fetch.js';

describe('locations.find', () => {
  const locations = [
    { id: '66330d45f6e1ebe224e226a1', location_name: 'Phú Quốc', abbreviation: 'PQ' },
    { id: '66330d45f6e1ebe224e226a2', location_name: 'Rạch Giá', abbreviation: 'RG' },
    { id: '66330d45f6e1ebe224e226a3', location_name: 'Đảo Nam Du', abbreviation: 'ND' },
  ];

  it('matches accent-insensitively by name, abbreviation and id', async () => {
    const m = mockFetch(() => json(locations));
    const ferry = new FerryClient({ fetch: m.fetch });
    expect((await ferry.locations.find('phu quoc')).map((l) => l.abbreviation)).toEqual(['PQ']);
    expect((await ferry.locations.find('rg')).map((l) => l.abbreviation)).toEqual(['RG']);
    expect((await ferry.locations.find('dao nam')).map((l) => l.abbreviation)).toEqual(['ND']);
    expect((await ferry.locations.find('66330d45f6e1ebe224e226a2')).map((l) => l.abbreviation)).toEqual(['RG']);
    expect(normalizeText('  Đà  Nẵng ')).toBe('da nang');
  });
});
