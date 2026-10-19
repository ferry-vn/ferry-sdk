/**
 * Helpers for the boat-layout seat map.
 *
 * The backend stores each floor as parallel arrays (`SeatIds[i]`, `SeatNames[i]`,
 * `IsBookeds[i]`, ...). `flattenSeatMap` turns that into one object per seat,
 * carrying exactly the fields `CreateTicketDto` needs (seat_id, seat_name,
 * position_id, seat_type_code, sort_auto, floor_id).
 *
 * Seat names are not guaranteed unique on a floor (seen on real layouts), so
 * identify a seat by `positionId` when it matters (`seatRef()` gives `NAME#POSITION`).
 */
import type { BoatLayout, BoatLayoutWithAdditions } from './types.js';

export interface SeatInfo {
  floorId: string;
  /** Position of the floor in the layout (floor ids are not always unique). */
  floorIndex: number;
  floorName: string | undefined;
  seatId: number | undefined;
  seatName: string | undefined;
  seatType: string | undefined;
  positionId: number | undefined;
  sortAuto: number | undefined;
  row: number | undefined;
  col: number | undefined;
  isVip: boolean;
  isBooked: boolean;
  isHeld: boolean;
  isExported: boolean;
  /** Seat that can currently be sold (a real seat, not booked/held/exported). */
  available: boolean;
}

export interface SeatMapSummary {
  voyageId: string | undefined;
  total: number;
  available: number;
  floors: Array<{ floorId: string; floorName: string | undefined; total: number; available: number }>;
  seats: SeatInfo[];
}

function layoutOf(input: BoatLayout | BoatLayoutWithAdditions): BoatLayout | undefined {
  return 'boatLayout' in input ? input.boatLayout : input;
}

/** Unambiguous seat reference accepted by the booking builder: `NAME#POSITION_ID`. */
export function seatRef(seat: Pick<SeatInfo, 'seatName' | 'positionId'>): string {
  return `${seat.seatName ?? ''}#${seat.positionId ?? ''}`;
}

export function flattenSeatMap(input: BoatLayout | BoatLayoutWithAdditions | null | undefined): SeatMapSummary {
  const layout = input ? layoutOf(input) : undefined;
  const seats: SeatInfo[] = [];
  const floors: SeatMapSummary['floors'] = [];
  for (const [floorIndex, floor] of (layout?.floors ?? []).entries()) {
    const n = Math.max(floor.SeatIds?.length ?? 0, floor.IsSeats?.length ?? 0, floor.SeatNames?.length ?? 0);
    let total = 0;
    let available = 0;
    for (let i = 0; i < n; i++) {
      // Cells that are not seats (aisles, stairs, labels) have IsSeats[i] === false.
      if (floor.IsSeats && floor.IsSeats[i] === false) continue;
      // Operators mark inactive (unsellable) seats with IsRenders[i] === false
      // (e.g. Lightning68: `IsRender = seat.status == 'active'`); the dashboard
      // hides them and the voyage's `no_remain` excludes them.
      if (floor.IsRenders && floor.IsRenders[i] === false) continue;
      const isBooked = Boolean(floor.IsBookeds?.[i]);
      const isHeld = Boolean(floor.IsHelds?.[i]);
      const isExported = Boolean(floor.IsExporteds?.[i]);
      const seat: SeatInfo = {
        floorId: floor.floor_id,
        floorIndex,
        floorName: floor.floor_name,
        seatId: floor.SeatIds?.[i],
        seatName: floor.SeatNames?.[i],
        seatType: floor.SeatTypes?.[i],
        positionId: floor.PositionIds?.[i],
        sortAuto: floor.SortAutos?.[i],
        row: floor.Rows?.[i],
        col: floor.Cols?.[i],
        isVip: Boolean(floor.IsVIPs?.[i]),
        isBooked,
        isHeld,
        isExported,
        available: !isBooked && !isHeld && !isExported,
      };
      total++;
      if (seat.available) available++;
      seats.push(seat);
    }
    floors.push({ floorId: floor.floor_id, floorName: floor.floor_name, total, available });
  }
  return {
    voyageId: layout?.voyage_id,
    total: seats.length,
    available: seats.filter((s) => s.available).length,
    floors,
    seats,
  };
}
