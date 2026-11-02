// Real `intentfolio-staging.near` transactions as FastNEAR's `/v0/transactions` returns them,
// trimmed to the fields the history reader uses (args and gas dropped, long success values cut).
// Captured 2026-09-28 (triage 016, block 1b); see D-339 for the measurement they come from.
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract events) and #21 (FastNEAR).

import type { FastNearTx } from "./vault-history-client";

export const CREATE: FastNearTx = {
  "transaction": {
    "hash": "3wb6VoXoDBt1dVMs7Zq8ZJNqu4QfL3ui8MGnj1xVacpr",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790265791572164860
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790265792089440043,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"GbcCuCTH3ZiTMSkMXU8ifZbUWihY7Edm4rv3v2CfWbPu\",\"account_id\":\"pablofork.near\",\"receiver_id\":\"intentfolio-staging.near\",\"tokens\":{\"nep141:meta-pool.near\":\"666273744117494233559424\",\"nep141:usdt.tether-token.near\":\"4400000\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.1\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"GbcCuCTH3ZiTMSkMXU8ifZbUWihY7Edm4rv3v2CfWbPu\",\"account_id\":\"pablofork.near\",\"nonce\":\"Vij2xgAlKBKzANIgxwtf2xgN+UkfYenex2IKN9hKS5Q=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"pablofork.near\",\"new_owner_id\":\"intentfolio-staging.near\",\"token_ids\":[\"nep141:usdt.tether-token.near\",\"nep141:meta-pool.near\"],\"amounts\":[\"4400000\",\"666273744117494233559424\"]}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790265792721709105,
        "outcome": {
          "executor_id": "intentfolio-staging.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"portfolio_created\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000017\",\"name\":\"canary-931-stnear\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"allocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000017\",\"token\":\"nep141:meta-pool.near\",\"qty\":\"666273744117494233559424\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"allocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000017\",\"token\":\"nep141:usdt.tether-token.near\",\"qty\":\"4400000\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790265792721709105,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790265793443825514,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const ALLOCATE_INTO: FastNearTx = {
  "transaction": {
    "hash": "29nMX4mxpeo8PHYyGeTn3szowBpbD5KmGoWYYTLMTAwA",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790349345330813116
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790349345997977686,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"23kqhYz4n3pB46MESjcbeUC98cjrx9hUv84FivsPy3Sa\",\"account_id\":\"pablofork.near\",\"receiver_id\":\"intentfolio-staging.near\",\"tokens\":{\"nep141:meta-pool.near\":\"200000000000000000000000\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.1\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"23kqhYz4n3pB46MESjcbeUC98cjrx9hUv84FivsPy3Sa\",\"account_id\":\"pablofork.near\",\"nonce\":\"Vij2xgAlKBKzABoncwar2xj2/BFexM1GwLdC4FFKTEQ=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"pablofork.near\",\"new_owner_id\":\"intentfolio-staging.near\",\"token_ids\":[\"nep141:meta-pool.near\"],\"amounts\":[\"200000000000000000000000\"]}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790349346502231780,
        "outcome": {
          "executor_id": "intentfolio-staging.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"allocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000017\",\"token\":\"nep141:meta-pool.near\",\"qty\":\"200000000000000000000000\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790349346502231780,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790349347239129875,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const UNALLOCATE_TWO: FastNearTx = {
  "transaction": {
    "hash": "G8VtfBWUFK2wPdYPxmYYnYJ4jwWXFbAho662avvZusT8",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-staging.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790215059665341192
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790215060212894310,
        "outcome": {
          "executor_id": "intentfolio-staging.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"pending_unallocation_opened\",\"data\":[{\"commit_id\":\"2411ee63c703ea04a33db7b386105340b0dd514d2fc06f40e92085c6dd43d517\",\"legs\":[[\"p_000000000011\",\"nep141:meta-pool.near\",\"161137488812877562241472\"],[\"p_000000000011\",\"nep141:usdt.tether-token.near\",\"3741385\"]]}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790215060822972993,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"intentfolio-staging.near\",\"new_owner_id\":\"pablofork.near\",\"token_ids\":[\"nep141:meta-pool.near\",\"nep141:usdt.tether-token.near\"],\"amounts\":[\"161137488812877562241472\",\"3741385\"],\"memo\":\"2411ee63c703ea04a33db7b386105340b0dd514d2fc06f40e92085c6dd43d517\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790215060822972993,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790215061298407927,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790215061298407927,
        "outcome": {
          "executor_id": "intentfolio-staging.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"unallocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000011\",\"token\":\"nep141:meta-pool.near\",\"qty\":\"161137488812877562241472\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"unallocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000011\",\"token\":\"nep141:usdt.tether-token.near\",\"qty\":\"3741385\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790215061678424235,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const RESCUED_CREATE: FastNearTx = {
  "transaction": {
    "hash": "2FAuq7bzKSE7iw62oGPhmejkdZUZvC92YAMh9ELaaJMx",
    "signer_id": "intentfolio-solver.near",
    "receiver_id": "intentfolio-staging.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790029307453869355
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790029308138138914,
        "outcome": {
          "executor_id": "intentfolio-staging.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"portfolio_created\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000012\",\"name\":\"orphan-922-f4-shadow\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"allocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000012\",\"token\":\"nep141:wrap.near\",\"qty\":\"248071769999999997002859\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"1.0.0\",\"event\":\"pending_allocation_claimed\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000012\",\"token\":\"nep141:wrap.near\",\"qty\":\"248071769999999997002859\",\"intent_hash\":\"47ee44566727b6f8349bc57ae3077314bf6eca8c382955499b14daf366fab47c\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790029308749136032,
        "outcome": {
          "executor_id": "intentfolio-solver.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const FAILED_ALLOCATE: FastNearTx = {
  "transaction": {
    "hash": "9KdHjDBrtkDkJndCm8Yy9VEAybatuDrX5LXHeDGanwR",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790028233570609550
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790028234274108849,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"4qYpHMFm89SMmuk9z9fBwpf2ZFTmH5X4y7NFFU32wBJH\",\"account_id\":\"pablofork.near\",\"receiver_id\":\"intentfolio-staging.near\",\"tokens\":{\"nep141:wrap.near\":\"248071769999999997002859\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.1\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"4qYpHMFm89SMmuk9z9fBwpf2ZFTmH5X4y7NFFU32wBJH\",\"account_id\":\"pablofork.near\",\"nonce\":\"Vij2xgAlKBKzANLgqvqG2hgnOmuWPTNajd1Mo1fN/4k=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"pablofork.near\",\"new_owner_id\":\"intentfolio-staging.near\",\"token_ids\":[\"nep141:wrap.near\"],\"amounts\":[\"248071769999999997002859\"]}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790028234838327863,
        "outcome": {
          "executor_id": "intentfolio-staging.near",
          "logs": [],
          "status": {
            "Failure": {
              "ActionError": {
                "index": 0,
                "kind": {
                  "FunctionCallError": {
                    "ExecutionError": "WebAssembly trap: An `unreachable` opcode was executed."
                  }
                }
              }
            }
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790028234838327863,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790028235394135937,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const COMPOSITION_ONLY: FastNearTx = {
  "transaction": {
    "hash": "BEWSKGMeF2MKpVJrn5oMe5779oG2a1kTFoQ7mFMx23ps",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-staging.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790265435296954671
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790265436030126264,
        "outcome": {
          "executor_id": "intentfolio-staging.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790265436684813468,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

