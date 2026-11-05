# Tool inventory

Generated from the production registry by `npm run inventory:generate`.
12 tools and 4 prompts; no resources or persistent MCP sessions.

| Tool | Operation | Required scopes | Title |
| --- | --- | --- | --- |
| `book_check` | Read | `mcp:me:discover` | Check a slot and get the booking link |
| `business_get` | Read | `mcp:me:discover` | Get business card |
| `business_list_dates` | Read | `mcp:me:discover` | List dates with free time |
| `business_list_services` | Read | `mcp:me:discover` | List bookable services |
| `business_list_team_members` | Read | `mcp:me:discover` | List bookable team members |
| `business_list_time_slots` | Read | `mcp:me:discover` | List free time slots |
| `business_search` | Read | `mcp:me:discover` | Find a business by name |
| `me_book` | Confirmed write | `mcp:me:discover`, `mcp:me:read`, `mcp:me:book` | Book me in |
| `me_cancel_booking` | Confirmed write | `mcp:me:discover`, `mcp:me:read`, `mcp:me:book` | Cancel one of my bookings |
| `me_list_bookings` | Read | `mcp:me:discover`, `mcp:me:read` | List my bookings |
| `me_list_places` | Read | `mcp:me:discover`, `mcp:me:read` | List my places |
| `me_reschedule_booking` | Confirmed write | `mcp:me:discover`, `mcp:me:read`, `mcp:me:book` | Move one of my bookings |

## Prompts

- `book_my_usual`: Book my usual at a place I already go to
- `book_side_by_side`: Book two people side by side at a place I already go to
- `watch_for_a_free_slot`: Watch for a free time with my favourite team member
- `hold_a_slot`: Hold a time at a place I already go to
