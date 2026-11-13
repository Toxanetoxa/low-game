use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::{instruction as system_instruction, program as system_program};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

const DUEL_SEED: &[u8] = b"duel";
const STATE_LEN: usize = 96;
const VERSION: u8 = 1;
const UNSET: u8 = 0;
const CREATOR_WON: u8 = 1;
const OPPONENT_WON: u8 = 2;
const DRAW: u8 = 3;
const REFUNDED: u8 = 4;

#[repr(u32)]
enum EscrowError {
    InvalidPlayer = 1,
    InvalidStake,
    InvalidDeadline,
    AlreadyFunded,
    NotFunded,
    AlreadyVoted,
    Closed,
    RefundNotReady,
    InvalidOutcome,
}

impl From<EscrowError> for ProgramError {
    fn from(error: EscrowError) -> Self {
        Self::Custom(error as u32)
    }
}

struct Duel {
    creator: Pubkey,
    opponent: Pubkey,
    stake: u64,
    funding_deadline: u64,
    settlement_deadline: u64,
    funded: bool,
    outcome: u8,
    creator_vote: u8,
    opponent_vote: u8,
}

fn read_u64(data: &[u8]) -> Result<u64, ProgramError> {
    let bytes = data
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok(u64::from_le_bytes(bytes))
}

impl Duel {
    fn read(program_id: &Pubkey, account: &AccountInfo) -> Result<Self, ProgramError> {
        if account.owner != program_id || !account.is_writable {
            return Err(ProgramError::InvalidAccountOwner);
        }
        let data = account.try_borrow_data()?;
        if data.len() != STATE_LEN || data[0] != VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        let creator = Pubkey::new_from_array(data[8..40].try_into().unwrap());
        let opponent = Pubkey::new_from_array(data[40..72].try_into().unwrap());
        Ok(Self {
            creator,
            opponent,
            stake: read_u64(&data[72..80])?,
            funding_deadline: read_u64(&data[80..88])?,
            settlement_deadline: read_u64(&data[88..96])?,
            funded: data[1] == 1,
            outcome: data[2],
            creator_vote: data[3],
            opponent_vote: data[4],
        })
    }

    fn write(&self, account: &AccountInfo) -> ProgramResult {
        let mut data = account.try_borrow_mut_data()?;
        if data.len() != STATE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        data[..8].copy_from_slice(&[
            VERSION,
            self.funded.into(),
            self.outcome,
            self.creator_vote,
            self.opponent_vote,
            0,
            0,
            0,
        ]);
        data[8..40].copy_from_slice(self.creator.as_ref());
        data[40..72].copy_from_slice(self.opponent.as_ref());
        data[72..80].copy_from_slice(&self.stake.to_le_bytes());
        data[80..88].copy_from_slice(&self.funding_deadline.to_le_bytes());
        data[88..96].copy_from_slice(&self.settlement_deadline.to_le_bytes());
        Ok(())
    }

    fn require_open(&self) -> ProgramResult {
        if self.outcome == UNSET {
            Ok(())
        } else {
            Err(EscrowError::Closed.into())
        }
    }

    fn require_recipients(&self, creator: &AccountInfo, opponent: &AccountInfo) -> ProgramResult {
        if creator.key != &self.creator
            || opponent.key != &self.opponent
            || !creator.is_writable
            || !opponent.is_writable
        {
            return Err(EscrowError::InvalidPlayer.into());
        }
        Ok(())
    }

    fn vote(&mut self, voter: &Pubkey, outcome: u8, now: u64) -> ProgramResult {
        self.require_open()?;
        if !self.funded {
            return Err(EscrowError::NotFunded.into());
        }
        if now >= self.settlement_deadline {
            return Err(EscrowError::InvalidDeadline.into());
        }
        if !(CREATOR_WON..=DRAW).contains(&outcome) {
            return Err(EscrowError::InvalidOutcome.into());
        }

        let vote = if voter == &self.creator {
            &mut self.creator_vote
        } else if voter == &self.opponent {
            &mut self.opponent_vote
        } else {
            return Err(EscrowError::InvalidPlayer.into());
        };
        if *vote != UNSET {
            return Err(EscrowError::AlreadyVoted.into());
        }
        *vote = outcome;
        if self.creator_vote != UNSET && self.opponent_vote != UNSET {
            self.outcome = if self.creator_vote == self.opponent_vote {
                outcome
            } else {
                REFUNDED
            };
        }
        Ok(())
    }

    fn refund(&mut self, now: u64) -> ProgramResult {
        self.require_open()?;
        let deadline = if self.funded {
            self.settlement_deadline
        } else {
            self.funding_deadline
        };
        if now < deadline {
            return Err(EscrowError::RefundNotReady.into());
        }
        self.outcome = REFUNDED;
        Ok(())
    }

    fn pay(
        &self,
        escrow: &AccountInfo,
        creator: &AccountInfo,
        opponent: &AccountInfo,
    ) -> ProgramResult {
        match self.outcome {
            CREATOR_WON => move_lamports(escrow, creator, self.stake * 2),
            OPPONENT_WON => move_lamports(escrow, opponent, self.stake * 2),
            DRAW | REFUNDED => {
                move_lamports(escrow, creator, self.stake)?;
                if self.funded {
                    move_lamports(escrow, opponent, self.stake)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

fn unix_time() -> Result<u64, ProgramError> {
    u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| EscrowError::InvalidDeadline.into())
}

fn require_signer(account: &AccountInfo) -> ProgramResult {
    if account.is_signer {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
}

fn require_system(account: &AccountInfo) -> ProgramResult {
    if account.key == &system_program::ID {
        Ok(())
    } else {
        Err(ProgramError::IncorrectProgramId)
    }
}

fn require_wallet(account: &AccountInfo) -> ProgramResult {
    if account.owner == &system_program::ID && !account.executable && account.data_is_empty() {
        Ok(())
    } else {
        Err(EscrowError::InvalidPlayer.into())
    }
}

fn move_lamports(source: &AccountInfo, destination: &AccountInfo, amount: u64) -> ProgramResult {
    let mut from = source.try_borrow_mut_lamports()?;
    let mut to = destination.try_borrow_mut_lamports()?;
    let debit = from
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    let credit = to
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    **from = debit;
    **to = credit;
    Ok(())
}

fn create(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 40 || data[..16] == [0; 16] {
        return Err(ProgramError::InvalidInstructionData);
    }
    let room = &data[..16];
    let stake = read_u64(&data[16..24])?;
    let funding_deadline = read_u64(&data[24..32])?;
    let settlement_deadline = read_u64(&data[32..40])?;
    let rent = Rent::get()?;
    // A refund must be able to recreate a player's empty system account.
    if stake < rent.minimum_balance(0) || stake.checked_mul(2).is_none() {
        return Err(EscrowError::InvalidStake.into());
    }
    if funding_deadline <= unix_time()? || settlement_deadline <= funding_deadline {
        return Err(EscrowError::InvalidDeadline.into());
    }

    let mut accounts = accounts.iter();
    let creator = next_account_info(&mut accounts)?;
    let opponent = next_account_info(&mut accounts)?;
    let escrow = next_account_info(&mut accounts)?;
    let system = next_account_info(&mut accounts)?;
    require_signer(creator)?;
    require_system(system)?;
    require_wallet(creator)?;
    require_wallet(opponent)?;
    if creator.key == opponent.key
        || opponent.key == escrow.key
        || opponent.key == &system_program::ID
        || !creator.is_writable
        || !escrow.is_writable
    {
        return Err(EscrowError::InvalidPlayer.into());
    }

    let (expected, bump) =
        Pubkey::find_program_address(&[DUEL_SEED, creator.key.as_ref(), room], program_id);
    if escrow.key != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    if escrow.owner != &system_program::ID || !escrow.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let minimum = rent.minimum_balance(STATE_LEN);
    let rent_top_up = minimum.saturating_sub(escrow.lamports());
    let amount = rent_top_up
        .checked_add(stake)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let signer: &[&[u8]] = &[DUEL_SEED, creator.key.as_ref(), room, &[bump]];
    invoke(
        &system_instruction::transfer(creator.key, escrow.key, amount),
        &[creator.clone(), escrow.clone(), system.clone()],
    )?;
    // Allocate and assign separately so pre-funding the PDA cannot block creation.
    invoke_signed(
        &system_instruction::allocate(escrow.key, STATE_LEN as u64),
        &[escrow.clone(), system.clone()],
        &[signer],
    )?;
    invoke_signed(
        &system_instruction::assign(escrow.key, program_id),
        &[escrow.clone(), system.clone()],
        &[signer],
    )?;

    Duel {
        creator: *creator.key,
        opponent: *opponent.key,
        stake,
        funding_deadline,
        settlement_deadline,
        funded: false,
        outcome: UNSET,
        creator_vote: UNSET,
        opponent_vote: UNSET,
    }
    .write(escrow)
}

fn fund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let mut accounts = accounts.iter();
    let opponent = next_account_info(&mut accounts)?;
    let escrow = next_account_info(&mut accounts)?;
    let system = next_account_info(&mut accounts)?;
    let mut duel = Duel::read(program_id, escrow)?;
    duel.require_open()?;
    require_signer(opponent)?;
    require_system(system)?;
    if opponent.key != &duel.opponent || !opponent.is_writable {
        return Err(EscrowError::InvalidPlayer.into());
    }
    if duel.funded {
        return Err(EscrowError::AlreadyFunded.into());
    }
    if unix_time()? >= duel.funding_deadline {
        return Err(EscrowError::InvalidDeadline.into());
    }
    invoke(
        &system_instruction::transfer(opponent.key, escrow.key, duel.stake),
        &[opponent.clone(), escrow.clone(), system.clone()],
    )?;
    duel.funded = true;
    duel.write(escrow)
}

fn settle(program_id: &Pubkey, accounts: &[AccountInfo], vote: Option<u8>) -> ProgramResult {
    let mut accounts = accounts.iter();
    let voter = if vote.is_some() {
        let signer = next_account_info(&mut accounts)?;
        require_signer(signer)?;
        Some(signer.key)
    } else {
        None
    };
    let escrow = next_account_info(&mut accounts)?;
    let creator = next_account_info(&mut accounts)?;
    let opponent = next_account_info(&mut accounts)?;
    let mut duel = Duel::read(program_id, escrow)?;
    duel.require_recipients(creator, opponent)?;
    let now = unix_time()?;
    if let Some((voter, outcome)) = voter.zip(vote) {
        duel.vote(voter, outcome, now)?;
    } else {
        duel.refund(now)?;
    }
    duel.pay(escrow, creator, opponent)?;
    duel.write(escrow)
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data {
        [0, create_data @ ..] => create(program_id, accounts, create_data),
        [1] => fund(program_id, accounts),
        [2, outcome] => settle(program_id, accounts, Some(*outcome)),
        [3] => settle(program_id, accounts, None),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn duel(funded: bool) -> Duel {
        Duel {
            creator: Pubkey::new_unique(),
            opponent: Pubkey::new_unique(),
            stake: 1_000_000,
            funding_deadline: 100,
            settlement_deadline: 200,
            funded,
            outcome: UNSET,
            creator_vote: UNSET,
            opponent_vote: UNSET,
        }
    }

    #[test]
    fn matching_votes_settle_and_cannot_be_changed() {
        let mut match_state = duel(true);
        let (creator, opponent) = (match_state.creator, match_state.opponent);
        assert_eq!(
            match_state.vote(&Pubkey::new_unique(), OPPONENT_WON, 150),
            Err(EscrowError::InvalidPlayer.into())
        );
        match_state.vote(&creator, OPPONENT_WON, 150).unwrap();
        assert_eq!(match_state.outcome, UNSET);
        assert_eq!(
            match_state.vote(&creator, CREATOR_WON, 150),
            Err(EscrowError::AlreadyVoted.into())
        );
        match_state.vote(&opponent, OPPONENT_WON, 150).unwrap();
        assert_eq!(match_state.outcome, OPPONENT_WON);
        assert_eq!(match_state.refund(200), Err(EscrowError::Closed.into()));
    }

    #[test]
    fn conflicting_votes_refund() {
        let mut match_state = duel(true);
        let (creator, opponent) = (match_state.creator, match_state.opponent);
        match_state.vote(&creator, DRAW, 150).unwrap();
        match_state.vote(&opponent, CREATOR_WON, 150).unwrap();
        assert_eq!(match_state.outcome, REFUNDED);
    }

    #[test]
    fn refund_uses_the_deadline_for_the_funding_state() {
        for (funded, deadline) in [(false, 100), (true, 200)] {
            let mut match_state = duel(funded);
            assert_eq!(
                match_state.refund(deadline - 1),
                Err(EscrowError::RefundNotReady.into())
            );
            let creator = match_state.creator;
            let vote_error = if funded {
                EscrowError::InvalidDeadline
            } else {
                EscrowError::NotFunded
            };
            assert_eq!(
                match_state.vote(&creator, DRAW, deadline),
                Err(vote_error.into())
            );
            match_state.refund(deadline).unwrap();
            assert_eq!(match_state.outcome, REFUNDED);
        }
    }
}
