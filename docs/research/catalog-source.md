# Catalog source for business search (B1)

**Status: parked 2026-10-08** ([ADR 0005](../decisions/0005-own-places-first.md)). No crawl, no own index; kept as research on record. An index by API crawl is the wrong architecture (platform owner, 2026-10-07): if ever needed, it is a ClickHouse or Elastic index built by the development team with a direct connector.

Research date: 2026-10-03. Answers open question B1 without the backend team, at the owner's
request. Sources: `altegio/biz.erp` code (read via `gh`), the BI replica (read-only aggregate
queries, no personal data). No live API calls were made.

## Recommendation for v1

Crawl the public `GET /api/v1/companies` nightly with our own partner token and build the index
from it. It is documented, needs no approval, returns every field the index needs, and a full
crawl is about 75 + 150 requests. Use the BI replica only to cross-check counts, never as the
production source.

## Candidate sources

| Source | Data | Freshness | Limits | Production use | Effort |
|---|---|---|---|---|---|
| `GET /companies` (partner token) | id, title, public title, logo, country and city (id, name), address, zip, lat/lon, timezone, currency, business group and type, `active`, chain, photos. `showBookforms=1` adds bookform ids, URLs and `default_bookform_url`; `forBooking=1` adds `active_staff_count` and `next_slot` | Live | 100 requests per 10 s per token (sliding window); page size up to 1000; `page` or `min_id` pagination; no `fields` option | Documented and legitimate, but broad calls are logged as "suspicious search params". No online-services flag | Low |
| BI replica (schema `salon`) | Every flag, including online services, staff schedules, Google and 2GIS flags | About 1 s lag | None formal; shared BI server | Shared SELECT-only BI login, no SLA, not approved for production use | Low to medium |
| Reserve with Google merchant feed | Ready "bookable" rules | Daily | n/a | Written to a separate Google database; opt-in (`google_map_booking_allowed`, default 0). Reuse the rules only | n/a |
| 2GIS feed | Name, address, coordinates, default bookform | Daily | n/a | Kazakhstan, Uzbekistan, Kyrgyzstan only; enabled at onboarding (opt-out) | Not general |
| `/user/companies/yplaces`, v3 `/locations` | Not a catalog | | | | |

Notes on `GET /companies`:

- `forBooking=1` filters nothing. It only adds staff counts and the next slot, and logs a warning
  when a page holds more than 100 businesses.
- Default set: `deleted=0`, `active=1`, an active paid licence. Frozen licences are included with
  `active=0`.
- No text, geo or brand search. Partner types exempt from the rate limit: internal apps, widgets,
  `google_maps`, `yandex_maps`, 2GIS.
- No ready feed with opt-out semantics exists. 2GIS is the only opt-out precedent.

## v1 mechanics

1. Nightly crawl: `GET /companies?showBookforms=1&count=200`, paging with `min_id` = last id + 1
   (about 74 requests for about 14.6k rows). Keep `active == 1`.
2. Second pass: `GET /companies?forBooking=1&count=100` (about 147 requests); drop businesses with
   `active_staff_count == 0`. Do not rely on `next_slot`: a feature flag can leave it empty.
3. Health exclusion by configured ids, applied at index build:
   - `business_group_id = 2` (medicine), types 4, 31, 32, 38, 39, 40, 41, 42, 43, 44, 87, 91, 92, 103.
   - Health-adjacent types outside group 2, owner decision 2026-10-07: 35 cosmetology, 25 spa
     and 29 massage salon are listed (beauty and wellness; their medical counterparts are in
     group 2); 17 optics, 28 salt caves and group 9 "unknown" are excluded at launch, group 9
     to be revisited after a classification pass.
4. Store per business: id, titles, city, country, address, coordinates, type, group, chain,
   default bookform URL, logo, timezone, currency. About 1 KB per row, 12-15 MB in total; fits
   SQLite FTS5 or memory. Do not store phone numbers (personal data for private specialists).
5. Full rebuild nightly with an atomic swap; a failed or empty crawl keeps the previous index.
   Re-check the business with `GET /company/{id}?forBooking=1` at hand-off.

## Measured numbers (BI replica, 2026-10-03)

- Not deleted and `active=1`: 14,657. API default set: 14,646. Active, paid, not frozen: 14,305
  (1,231 on trial).
- Bookable (Google feed rules without the opt-in and record-type checks): 11,677; without
  medicine (group 2): 10,504.
- Bookable by group: beauty 8,434, medicine 1,173, sports 487, unknown 454 (8 with coordinates),
  other 328, leisure 264, household 175, education 134, auto 133, retail 95.
- Bookable medical types: 4 medical centre 449, 103 medical cosmetology 276, 91 wellness massage
  120, 32 dentistry 95, 92 private medical specialist 86, 87 other medicine 72, 43 alternative
  medicine 23, 39 diagnostics 15, 44 psychotherapy 15, 41 polyclinic 8, 38 women's consultation 6,
  31 vet 5, 42 hospital 2, 40 lab tests 1.
- Bookable health-adjacent types outside group 2: 35 cosmetology 420, 25 spa 231, 29 massage
  salon 132, 17 optics 10, 28 salt caves 2.
- Bookable by country (all / without medicine): Ukraine 4,258 / 3,917, Kazakhstan 1,570 / 1,270,
  Czechia 508 / 469, Uzbekistan 413 / 379, Moldova 381 / 335, Hungary 380 / 349, Poland 376 / 356,
  Kyrgyzstan 352 / 268, Armenia 285 / 238, UAE 255 / 217.
- Data quality of bookable businesses: 78% have an address, 65% coordinates, 63% a logo; 1,054
  cities.

## Risks

- The crawl is logged as "suspicious"; security could block the token. Consider telling the
  security or platform team before the first production crawl.
- Live page latency is untested; 1000-row pages may time out, hence 200.
- The API has no online-services flag. Compare `active_staff_count` once against the replica's
  "staff with a future schedule" count.
- Categories are chosen by the business at sign-up: beauty salons may offer medical services, and
  group 9 is unclassified.

## Evidence

- biz.erp: `src/Application/Http/Controllers/ApiLegacy/Company/UnAuth/PageApiCompaniesReadController.php`,
  `.../PageApiCompaniesRateLimiter.php`, `src/CTraitCompanyApi.php` (`getInfo`, fields at lines
  273-346), `src/CSalonFilter.php` (lines 336-375, 570-606),
  `src/More/Salon/Service/SalonService.php::isWidgetActive`,
  `src/More/GoogleMapsBookingApi/FeedObjectFinders/MerchantFinderService.php`,
  `src/More/Integration/Booking/TwoGis/Storages/TwoGisFeedStorage.php`,
  `src/More/Partner/Services/PartnerTypeChecker.php::isRateLimitingIgnored`, reference routes
  `/api/v1/references/business_type`, `/business_group`, `/business_groups_with_types`.
- Replica tables: `salon.salons`, `salon.biz_types`, `salon.biz_groups`,
  `salons_tariff_plans_link`, `salon_settings`, `booking_form`, `masters`,
  `master_schedules_till`, `salons_services_link`, `services`.
- Bookable query used for the counts:

```sql
FROM salons s JOIN (SELECT DISTINCT salon_id FROM salons_tariff_plans_link
  WHERE active=1 AND payment_status=1 AND is_freeze=0) l ON l.salon_id=s.id
WHERE s.deleted=0 AND s.active=1 AND s.trash=0
 AND EXISTS(SELECT 1 FROM booking_form bf WHERE bf.salon_id=s.id AND bf.deleted=0 AND bf.is_default=1)
 AND EXISTS(SELECT 1 FROM masters m JOIN master_schedules_till mst ON mst.master_id=m.id
   WHERE m.salon_id=s.id AND m.deleted=0 AND m.hide=0 AND mst.sch_till > UNIX_TIMESTAMP(CURDATE()))
 AND EXISTS(SELECT 1 FROM salons_services_link sl JOIN services se ON se.id=sl.service_id AND se.pid<>1
   WHERE sl.salon_id=s.id AND sl.type=1 AND sl.deleted=0 AND se.is_multi=0)
```
