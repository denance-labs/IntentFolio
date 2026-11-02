// Real `pablofork.near` transactions against the final vault (`intentfolio-vault.near`, v2) and
// `intents.near`, as FastNEAR's `/v0/transactions` returns them, trimmed to the fields the
// history reader uses: receipts without logs dropped, success values cut. Captured 2026-10-03
// (017-7, s219) from the operator's real-money test of s217.
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract events) and #21 (FastNEAR).

import type { FastNearTx } from "./vault-history-client";

export const V2_CREATE: FastNearTx = {
  "transaction": {
    "hash": "2CPtGijvcxNiUEuahsWVEGy22wt6hwP4Zg1Yq71NF3gK",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790832759354325321
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790832759941112706,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"J8u2hD9CwGifNQQEjmpmqcdTeUiMVXW74dSHrhXefC7V\",\"account_id\":\"pablofork.near\",\"receiver_id\":\"intentfolio-vault.near\",\"tokens\":{\"nep141:usdt.tether-token.near\":\"2457698\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.1\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"J8u2hD9CwGifNQQEjmpmqcdTeUiMVXW74dSHrhXefC7V\",\"account_id\":\"pablofork.near\",\"nonce\":\"Vij2xgAlKBKzAOjsNLFi3Ri6bzPya1YPlBwWMnC7+so=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"pablofork.near\",\"new_owner_id\":\"intentfolio-vault.near\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"2457698\"]}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790832760551255671,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"register_user\",\"data\":[{\"account_id\":\"pablofork.near\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"link_wallet\",\"data\":[{\"account_id\":\"pablofork.near\",\"chain\":\"near\",\"address\":\"pablofork.near\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_created\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"name\":\"Aggressive\"}]}",
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"allocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"token\":\"nep141:usdt.tether-token.near\",\"qty\":\"2457698\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const V2_RENAME: FastNearTx = {
  "transaction": {
    "hash": "8rwZrKHcRp5edkBHrQSHmhMyMJRAwM9c3FnUbPwfc2R3",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790833039194344477
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790833039818227280,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_renamed\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"name\":\"AgrRenamed\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const V2_COMPOSITION: FastNearTx = {
  "transaction": {
    "hash": "BSeAtKgKi7CBrkckhen4QuyAVbWSxyg3Ej7BHRjwa7aA",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790834146860101901
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790834147455869194,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_composition_changed\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000001\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const V2_DELETE: FastNearTx = {
  "transaction": {
    "hash": "FqFndxqxgHP52PeavuoDDpocw3xtKZfqwfda3oME2Py4",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790833460030331645
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790833460640328836,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_deleted\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"by\":\"owner\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const V2_UNALLOCATE: FastNearTx = {
  "transaction": {
    "hash": "82zCvEdjEDPg49ygj8snG72SwkfyqL53Z7S9hi3LLQWH",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790833348995105732
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790833349662127429,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"pending_unallocation_opened\",\"data\":[{\"commit_id\":\"83f32a1de80d0f05a77e131fcaf7b301caf7ea2891d8eb9ee83ebf32ab74641f\",\"legs\":[[\"p_000000000000\",\"nep141:usdt.tether-token.near\",\"2457698\"]]}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790833350128070342,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"intentfolio-vault.near\",\"new_owner_id\":\"pablofork.near\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"2457698\"],\"memo\":\"83f32a1de80d0f05a77e131fcaf7b301caf7ea2891d8eb9ee83ebf32ab74641f\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790833350837379841,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"unallocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"token\":\"nep141:usdt.tether-token.near\",\"qty\":\"2457698\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const WITHDRAW_USDT: FastNearTx = {
  "transaction": {
    "hash": "3rhK3x3uvJ9dN9RJRhWm3PhT52WuT9X12EUaMkZXdecp",
    "signer_id": "intents.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790833234004072029
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790833234004072029,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"ft_withdraw\",\"data\":[{\"intent_hash\":\"EpqKNvqdFcrNS2g6aLqSWFN6RWe92a65jzc3WVQFgvKj\",\"account_id\":\"pablofork.near\",\"token\":\"usdt.tether-token.near\",\"receiver_id\":\"pablofork.near\",\"amount\":\"500000\",\"min_gas\":\"17050000000000\"}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.1\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"EpqKNvqdFcrNS2g6aLqSWFN6RWe92a65jzc3WVQFgvKj\",\"account_id\":\"pablofork.near\",\"nonce\":\"oxvIopSxk4+pPghegYv+ANdpt6YT7Wed8AND3xcG4tI=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_burn\",\"data\":[{\"owner_id\":\"pablofork.near\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"500000\"],\"memo\":\"withdraw\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790833234527096582,
        "outcome": {
          "executor_id": "usdt.tether-token.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"intents.near\",\"new_owner_id\":\"pablofork.near\",\"amount\":\"500000\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};

export const DEPOSIT_USDT: FastNearTx = {
  "transaction": {
    "hash": "BJAxVLikkE2XYnqWUJyp8U6QFrsGk3YqU95344qRacXC",
    "signer_id": "pablofork.near",
    "receiver_id": "usdt.tether-token.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790832236284048605
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790832236887194607,
        "outcome": {
          "executor_id": "usdt.tether-token.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"pablofork.near\",\"new_owner_id\":\"intents.near\",\"amount\":\"2457698\"}]}"
          ],
          "status": {
            "SuccessReceiptId": "6ZduRYsx3bwkapM5Xukf"
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790832237468767117,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_mint\",\"data\":[{\"owner_id\":\"pablofork.near\",\"token_ids\":[\"nep141:usdt.tether-token.near\"],\"amounts\":[\"2457698\"],\"memo\":\"deposit\"}]}"
          ],
          "status": {
            "SuccessValue": "IjAi"
          }
        }
      }
    }
  ]
};

export const FOREIGN_BURN: FastNearTx = {
  "transaction": {
    "hash": "4BRDideYiQT7DduE1WExRCJ6ECPanmhy6JjBawbzzUVR",
    "signer_id": "intents.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_timestamp": 1790799638066425753
  },
  "receipts": [
    {
      "execution_outcome": {
        "block_timestamp": 1790799638066425753,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"token_diff\",\"data\":[{\"intent_hash\":\"53XqLsrt7UuLtAqaR23Yr2PzotchSyiv57VtRQabcwE6\",\"account_id\":\"solver-multichain-asset.near\",\"diff\":{\"nep141:eth.bridge.near\":\"-229953772345998\",\"nep141:eth.omft.near\":\"229976770023000\"},\"fees_collected\":{\"nep141:eth.bridge.near\":\"229953773\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"token_diff\",\"data\":[{\"intent_hash\":\"598cqMnrJVdE7gA6VuArsVKn8axtvvGt54qcGxdXY247\",\"account_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"diff\":{\"nep141:eth.bridge.near\":\"229953542392225\",\"nep141:eth.omft.near\":\"-229977000000000\"},\"referral\":\"1click-mon8.app\",\"fees_collected\":{\"nep141:eth.omft.near\":\"229977000\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"transfer\",\"data\":[{\"intent_hash\":\"598cqMnrJVdE7gA6VuArsVKn8axtvvGt54qcGxdXY247\",\"account_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"receiver_id\":\"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd\",\"tokens\":{\"nep141:eth.omft.near\":\"23000000000\"}}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.0\",\"event\":\"ft_withdraw\",\"data\":[{\"intent_hash\":\"598cqMnrJVdE7gA6VuArsVKn8axtvvGt54qcGxdXY247\",\"account_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"token\":\"eth.bridge.near\",\"receiver_id\":\"pablofork.near\",\"amount\":\"229953542392225\",\"min_gas\":\"17050000000000\"}]}",
            "EVENT_JSON:{\"standard\":\"dip4\",\"version\":\"0.3.1\",\"event\":\"intents_executed\",\"data\":[{\"intent_hash\":\"53XqLsrt7UuLtAqaR23Yr2PzotchSyiv57VtRQabcwE6\",\"account_id\":\"solver-multichain-asset.near\",\"nonce\":\"sj43wCOn77svb7MSgokyXxZLw7ioxyaN5Bo8NufTCCc=\"},{\"intent_hash\":\"598cqMnrJVdE7gA6VuArsVKn8axtvvGt54qcGxdXY247\",\"account_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"nonce\":\"Vij2xgAlKBKzQHHoFvIy2hhv5gCrPb0L+4Ccs4Uyt1Y=\"}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_transfer\",\"data\":[{\"old_owner_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"new_owner_id\":\"7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05\",\"token_ids\":[\"nep141:eth.omft.near\"],\"amounts\":[\"229977000\"]},{\"old_owner_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"new_owner_id\":\"5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd\",\"token_ids\":[\"nep141:eth.omft.near\"],\"amounts\":[\"23000000000\"]},{\"old_owner_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"new_owner_id\":\"solver-multichain-asset.near\",\"token_ids\":[\"nep141:eth.omft.near\"],\"amounts\":[\"229976770023000\"]},{\"old_owner_id\":\"solver-multichain-asset.near\",\"new_owner_id\":\"7066024d3f20f94de601c003163367873cca78507eeca4df66d9be645f197f05\",\"token_ids\":[\"nep141:eth.bridge.near\"],\"amounts\":[\"229953773\"]},{\"old_owner_id\":\"solver-multichain-asset.near\",\"new_owner_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"token_ids\":[\"nep141:eth.bridge.near\"],\"amounts\":[\"229953542392225\"]}]}",
            "EVENT_JSON:{\"standard\":\"nep245\",\"version\":\"1.0.0\",\"event\":\"mt_burn\",\"data\":[{\"owner_id\":\"c05116782c32c7399750b96fa1bb006ab0b63bedfc041ca754bf63f3e2c02659\",\"token_ids\":[\"nep141:eth.bridge.near\"],\"amounts\":[\"229953542392225\"],\"memo\":\"withdraw\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    },
    {
      "execution_outcome": {
        "block_timestamp": 1790799638553524831,
        "outcome": {
          "executor_id": "eth.bridge.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"intents.near\",\"new_owner_id\":\"pablofork.near\",\"amount\":\"229953542392225\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          }
        }
      }
    }
  ]
};
