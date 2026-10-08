// Server prompts (D-03): the "sign in, pick a place, book your usual" path as
// one prompt a client can offer its user. Written in the user's voice, the way
// a client shows a prompt. It names tools and asks for nothing about the
// sign-in, which happens on the connector's own sign-in page and never in the
// chat; compliance checks the text like a tool description.

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
      'Shows the places I already go to, proposes my usual service and team member, and ends with a pre-filled booking link.',
    text: [
      'Show me the places I already go to with me_list_places and my bookings with me_list_bookings.',
      'For the place I pick, propose my usual service and team member from my last visit there.',
      'Find free dates and times with business_list_dates and business_list_time_slots, using that service and team member unless I choose otherwise.',
      'Check the time I choose with book_check and give me the pre-filled booking link.',
      'My sign-in is already done through the connector and nothing about it belongs in this chat.',
    ].join(' '),
  }),
]);
