export interface PollVoter {
  id: number;
  username: string;
  display_name?: string | null;
  avatar_path?: string | null;
  voted_at: number;
}

export interface PollOption {
  id: number;
  text: string;
  position: number;
  created_by: number;
  vote_count: number;
  percentage: number;
  is_winner: boolean;
  voters?: PollVoter[];
}

export interface Poll {
  id: number;
  message_id: number;
  chat_id: string;
  creator_id: number;
  question: string;
  description?: string | null;
  show_voter_names: boolean;
  multiple_choice: boolean;
  allow_add_options: boolean;
  allow_change_vote: boolean;
  closes_at?: number | null;
  closed_at?: number | null;
  created_at: number;
  total_voters: number;
  user_option_ids: number[];
  has_voted: boolean;
  can_add_option: boolean;
  options: PollOption[];
}

export interface PollDraft {
  question: string;
  description?: string;
  options: string[];
  showVoterNames: boolean;
  multipleChoice: boolean;
  allowAddOptions: boolean;
  allowChangeVote: boolean;
  closesAt?: number | null;
}
