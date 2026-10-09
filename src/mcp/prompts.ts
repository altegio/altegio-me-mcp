// Server prompts: one per case, each a path a client can offer its user:
// "sign in, pick a place, book your usual" (D-03), two people side by side
// (CASE-02, CASE-05) and watching for a free time as a scheduled task of the
// client's AI host (CASE-03, D-03). Written in the user's voice, the way a
// client shows a prompt, and taking no arguments. It names tools and asks for
// nothing about the sign-in, which happens on the connector's own sign-in page
// and never in the chat; compliance checks the text like a tool description.

export interface ServerPrompt {
  name: string;
  title: string;
  description: string;
  /** The text of the one user message the prompt returns. */
  text: string;
}

export const SERVER_PROMPTS: readonly ServerPrompt[] = Object.freeze([
  Object.freeze({
    name: 'book_my_usual',
    title: 'Book my usual at a place I already go to',
    description:
      'Shows the places I already go to, proposes my usual service and team member, and books it in the chat once I agree, or gives a pre-filled booking link when the business needs its widget.',
    text: [
      'Show me the places I already go to with me_list_places and my bookings with me_list_bookings.',
      'For the place I pick, propose my usual service and team member from my last visit there.',
      'Find free dates and times with business_list_dates and business_list_time_slots, using that service and team member unless I choose otherwise.',
      'Show me the booking for the time I choose with me_book and book it only after I say yes; if the business needs its booking widget, check the time with book_check and give me the pre-filled booking link.',
      'My sign-in is already done through the connector and nothing about it belongs in this chat.',
    ].join(' '),
  }),
  Object.freeze({
    name: 'book_side_by_side',
    title: 'Book two people side by side at a place I already go to',
    description:
      'Books two appointments that start at the same time with two different team members at one of my places, shown in one preview and booked once I agree, both under my name.',
    text: [
      'At one of my places from me_list_places, book two appointments that start at the same time with two different team members, for example one for me and one for my child.',
      'Pick the two team members with business_list_team_members and offer only the start times that business_list_time_slots shows for both of them on the same date.',
      'Show me the booking of both with one me_book call, my appointment plus second_appointment, and book it only after I say yes.',
      'Both bookings will be under my name and nothing about the other person is needed; each booking is moved or cancelled on its own.',
    ].join(' '),
  }),
  Object.freeze({
    name: 'watch_for_a_free_slot',
    title: 'Watch for a free time with my favourite team member',
    description:
      'Helps me set up a scheduled task in this app that checks the free times of my usual team member and tells me when one opens in my window; the task only reads, and a booking happens here in the chat once I pick a time.',
    text: [
      'Take the place, the service and the team member from my usual in me_list_places unless I name others, and the dates (within 62 days) and the times of day I give.',
      'Help me set up a scheduled task in this app, for example a scheduled task or a routine, that runs daily unless I ask for more often and at most once an hour, with only the ids, the dates and the times of day in its text.',
      'Each run checks business_list_dates for that team member, then business_list_time_slots for each date found, and tells me the free times inside my window or that there are none yet.',
      'A run books nothing.',
      'When I come back and pick a time, show me the booking with me_book and book it only after I say yes; if this connection cannot book, check the time with book_check and give me the pre-filled booking link.',
      'I stop the watch by pausing or deleting the task.',
    ].join(' '),
  }),
]);
