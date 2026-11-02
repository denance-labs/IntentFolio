// Real `intentfolio-vault.near` transactions, as FastNEAR's `/v0/transactions` returns them,
// trimmed to the fields the history recorder reads: logs and call arguments only on the vault's
// own receipts, success values cut, every receipt kept (the "finished" rule counts them).
// Captured 2026-10-16 (028-2, s291).
//
// Attribution: see ATTRIBUTIONS.md #8 (IntentFolio vault contract events) and #21 (FastNEAR).

import type { FastNearTx } from "@/features/vault/lib/vault-history-client";
export const REBALANCE: FastNearTx = {
  "transaction": {
    "hash": "6zuZRUkR1bppdVxtUSLDEmyPAx8iGg3BnqgZyF1fQWe4",
    "signer_id": "intentfolio-vault-solver.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_height": 220210867,
    "block_timestamp": 1792146512291701346,
    "outcome": {
      "receipt_ids": [
        "6NWnbp1uqQ4h9gS5WWc6bVB1YNGWVma6BuaLoeVCHzAU"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "6NWnbp1uqQ4h9gS5WWc6bVB1YNGWVma6BuaLoeVCHzAU",
        "block_height": 220210868,
        "block_timestamp": 1792146512996804074,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"external_rebalance\",\"data\":[{\"token_in\":\"nep141:wrap.near\",\"token_out\":\"nep141:usdt.tether-token.near\",\"attributions\":[{\"portfolio_id\":\"p_000000000001\",\"qty_in\":\"84046287820715792235350\",\"qty_out\":\"444329\",\"attributed_spread\":\"593\"}]}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "4giY1nsYcr3LUJBw5XE7aTeXf5wWXkk6FR46tTDK5Rde"
          ]
        }
      },
      "receipt": {
        "receipt_id": "6NWnbp1uqQ4h9gS5WWc6bVB1YNGWVma6BuaLoeVCHzAU",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "reconcile_balances",
                  "args": ""
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "4giY1nsYcr3LUJBw5XE7aTeXf5wWXkk6FR46tTDK5Rde",
        "block_height": 220210869,
        "block_timestamp": 1792146513664272122,
        "outcome": {
          "executor_id": "intentfolio-vault-solver.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};
export const CREATE_FIRST: FastNearTx = {
  "transaction": {
    "hash": "2CPtGijvcxNiUEuahsWVEGy22wt6hwP4Zg1Yq71NF3gK",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 218018859,
    "block_timestamp": 1790832759354325321,
    "outcome": {
      "receipt_ids": [
        "6yJMioyNcMdcRVSrr5FrmdroNcLypr7ffjxyen9jZEEi"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "6yJMioyNcMdcRVSrr5FrmdroNcLypr7ffjxyen9jZEEi",
        "block_height": 218018860,
        "block_timestamp": 1790832759941112706,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "FDML2Up1bruUMWYLJwGxaqZKBmQ3FBPJc8tMWcda4ppf",
            "9GtZSYocjg1zu3VSwzHGTT93xN1LeJiCC26JQHH4gvM1"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "FDML2Up1bruUMWYLJwGxaqZKBmQ3FBPJc8tMWcda4ppf",
        "block_height": 218018861,
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
          },
          "receipt_ids": [
            "3W3jTxBXaLKP8mndPPBYrGZkiKGVCBYEbdVXktA3M5rv"
          ]
        }
      },
      "receipt": {
        "receipt_id": "FDML2Up1bruUMWYLJwGxaqZKBmQ3FBPJc8tMWcda4ppf",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "on_auth",
                  "args": "eyJzaWduZXJfaWQiOiJwYWJsb2ZvcmsubmVhciIsIm1zZyI6IntcImRlYWRsaW5lXCI6MTc5MTA5MTk0MCxcIm5vbmNlXCI6WzIzMCwyNTEsMjQzLDMwLDI5LDE5MCw0MSwxNjUsMjA3LDIxNiwyMjUsNzQsNTEsNDYsMTg4LDEsMTUyLDE0MywxMjcsMTUzLDE1MywxNTIsOTAsMTE1LDIyNSw0MCwyMjksMjAyLDU0LDQsMTQ5LDExMl0sXCJvcFwiOntcInNldHVwXCI6e1wibG9naW5fd2FsbGV0XCI6e1wiY2hhaW5cIjpcIm5lYXJcIixcImFkZHJlc3NcIjpcInBhYmxvZm9yay5uZWFyXCJ9LFwicG9ydGZvbGlvX25hbWVcIjpcIkFnZ3Jlc3NpdmVcIixcImNvbXBvc2l0aW9uXCI6W3tcInRva2VuX2lkXCI6XCJuZXAxNDE6bmJ0Yy5icmlkZ2UubmVhclwiLFwidGFyZ2V0X2Jwc1wiOjUwMDAsXCJ0b2xlcmFuY2VfYnBzXCI6MTIwMH0se1widG9rZW5faWRcIjpcIm5lcDE0MTpldGguYnJpZGdlLm5lYXJcIixcInRhcmdldF9icHNcIjo1MDAwLFwidG9sZXJhbmNlX2Jwc1wiOjEyMDB9XSxcImFsbG9jYXRpb25zXCI6W1tcIm5lcDE0MTp1c2R0LnRldGhlci10b2tlbi5uZWFyXCIsXCIyNDU3Njk4XCJdXX19fSJ9"
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "9GtZSYocjg1zu3VSwzHGTT93xN1LeJiCC26JQHH4gvM1",
        "block_height": 218018861,
        "block_timestamp": 1790832760551255671,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "3W3jTxBXaLKP8mndPPBYrGZkiKGVCBYEbdVXktA3M5rv",
        "block_height": 218018862,
        "block_timestamp": 1790832761212060323,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};
export const COMMIT_WITHDRAW: FastNearTx = {
  "transaction": {
    "hash": "82zCvEdjEDPg49ygj8snG72SwkfyqL53Z7S9hi3LLQWH",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_height": 218019868,
    "block_timestamp": 1790833348995105732,
    "outcome": {
      "receipt_ids": [
        "Bv3EuuEpg8QMH5eSSLzFo28AdEjRU1JgMgvqDJXqbRXv"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "Bv3EuuEpg8QMH5eSSLzFo28AdEjRU1JgMgvqDJXqbRXv",
        "block_height": 218019869,
        "block_timestamp": 1790833349662127429,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"pending_unallocation_opened\",\"data\":[{\"commit_id\":\"83f32a1de80d0f05a77e131fcaf7b301caf7ea2891d8eb9ee83ebf32ab74641f\",\"legs\":[[\"p_000000000000\",\"nep141:usdt.tether-token.near\",\"2457698\"]]}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "3D5M8kJ4S2LZ8CQPEdHSTob4mb6YdUVKe1RJivN9TTvz",
            "EbPdGDQgH85YVoUPTgHZ8JWibJjZL6BrsVNvn2sH9WLD",
            "7y9MGih1Hy9iW4XKNXbUHzJqm1Mc54rsPKAVJ1RRcEyA"
          ]
        }
      },
      "receipt": {
        "receipt_id": "Bv3EuuEpg8QMH5eSSLzFo28AdEjRU1JgMgvqDJXqbRXv",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "commit_portfolio_changes",
                  "args": "eyJwYXlsb2FkIjp7InN0YW5kYXJkIjoibmVwNDEzIiwicGF5bG9hZCI6eyJtZXNzYWdlIjoie1wic2lnbmVyX2lkXCI6XCJwYWJsb2ZvcmsubmVhclwiLFwiZGVhZGxpbmVcIjpcIjIwMjYtMTAtMDFUMDU6NTI6MjMuMDAwWlwiLFwicG9ydGZvbGlvX2lkXCI6XCJwXzAwMDAwMDAwMDAwMFwiLFwidGFyZ2V0X2NoYW5nZXNcIjpbXSxcInRva2VuX2FkZGl0aW9uc1wiOltdLFwidG9rZW5fcmVtb3ZhbHNcIjpbXSxcInVuYWxsb2NhdGlvbnNcIjpbW1wibmVwMTQxOnVzZHQudGV0aGVyLXRva2VuLm5lYXJcIixcIjI0NTc2OThcIl1dfSIsIm5vbmNlIjoiVmlqMnhnQUFBQUFBQUNZNm9QdFIyaGpyZXBCV2RpK3FYbDZxL09NcWxHYz0iLCJyZWNpcGllbnQiOiJpbnRlbnRmb2xpby12YXVsdC5uZWFyIn0sInB1YmxpY19rZXkiOiJlZDI1NTE5OjJFVmd5SHlSWlpVV3JmZmVMcmloWUI4dkZMV2Z3UXZlNk1BNWVpV2FVZnhWIiwic2lnbmF0dXJlIjoiZWQyNTUxOTo1RkNUcm5ldndkRFFwdE14bTZjNUJMSjk1U25mbzQxdnZZdkxtYnNQaDV2YnVkdldSVlJBaFZGQ3hLaGVXMkp6bkszWVoyRUwxdE1iUkdKWmNTelk2YXdDIn19"
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "3D5M8kJ4S2LZ8CQPEdHSTob4mb6YdUVKe1RJivN9TTvz",
        "block_height": 218019870,
        "block_timestamp": 1790833350128070342,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "A5STyAU6VZdaCTyEehcX9j5tGXWo1v7NG7yUeouHS4qp"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "7y9MGih1Hy9iW4XKNXbUHzJqm1Mc54rsPKAVJ1RRcEyA",
        "block_height": 218019870,
        "block_timestamp": 1790833350128070342,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "A5STyAU6VZdaCTyEehcX9j5tGXWo1v7NG7yUeouHS4qp",
        "block_height": 218019871,
        "block_timestamp": 1790833350837379841,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "EbPdGDQgH85YVoUPTgHZ8JWibJjZL6BrsVNvn2sH9WLD",
        "block_height": 218019871,
        "block_timestamp": 1790833350837379841,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"unallocate\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"token\":\"nep141:usdt.tether-token.near\",\"qty\":\"2457698\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "2yvu4cdtvYwWKkHCMtwPKfHd8xoPBPZAv3LkNmLYj6Na"
          ]
        }
      },
      "receipt": {
        "receipt_id": "EbPdGDQgH85YVoUPTgHZ8JWibJjZL6BrsVNvn2sH9WLD",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "on_unallocate_resolved",
                  "args": ""
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "2yvu4cdtvYwWKkHCMtwPKfHd8xoPBPZAv3LkNmLYj6Na",
        "block_height": 218019872,
        "block_timestamp": 1790833351457021488,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};
export const RENAME: FastNearTx = {
  "transaction": {
    "hash": "8rwZrKHcRp5edkBHrQSHmhMyMJRAwM9c3FnUbPwfc2R3",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_height": 218019336,
    "block_timestamp": 1790833039194344477,
    "outcome": {
      "receipt_ids": [
        "52z1qKZL66BBDnZRiDw4PcGaSAmGHabzqB1HcRZG1FZS"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "52z1qKZL66BBDnZRiDw4PcGaSAmGHabzqB1HcRZG1FZS",
        "block_height": 218019337,
        "block_timestamp": 1790833039818227280,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_renamed\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"name\":\"AgrRenamed\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "6HM6wFzgjNRxbj7DvcK5qP9DwbJHrK86p8AJgB33VwiL"
          ]
        }
      },
      "receipt": {
        "receipt_id": "52z1qKZL66BBDnZRiDw4PcGaSAmGHabzqB1HcRZG1FZS",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "commit_portfolio_changes",
                  "args": "eyJwYXlsb2FkIjp7InN0YW5kYXJkIjoibmVwNDEzIiwicGF5bG9hZCI6eyJtZXNzYWdlIjoie1wic2lnbmVyX2lkXCI6XCJwYWJsb2ZvcmsubmVhclwiLFwiZGVhZGxpbmVcIjpcIjIwMjYtMTAtMDFUMDU6NDY6NTkuMDAwWlwiLFwicG9ydGZvbGlvX2lkXCI6XCJwXzAwMDAwMDAwMDAwMFwiLFwidGFyZ2V0X2NoYW5nZXNcIjpbXSxcInRva2VuX2FkZGl0aW9uc1wiOltdLFwidG9rZW5fcmVtb3ZhbHNcIjpbXSxcInVuYWxsb2NhdGlvbnNcIjpbXSxcIm5hbWVcIjpcIkFnclJlbmFtZWRcIn0iLCJub25jZSI6IlZpajJ4Z0FBQUFBQUFINVNNTEJSMmhneUtpRkczWXdNMkJxNzJCRGJPbmM9IiwicmVjaXBpZW50IjoiaW50ZW50Zm9saW8tdmF1bHQubmVhciJ9LCJwdWJsaWNfa2V5IjoiZWQyNTUxOToyRVZneUh5UlpaVVdyZmZlTHJpaFlCOHZGTFdmd1F2ZTZNQTVlaVdhVWZ4ViIsInNpZ25hdHVyZSI6ImVkMjU1MTk6NGtmTnlFdmtoU3JCZFFlMUhiUndQa1p1R1BUM3Ztamt6M1dvS1NjWHJmUG0zUlpURFczY3F1eE41TnhkYWhyakFnc0VUbWJTMVZtaDZVdnZwZVJ5aEdlNyJ9fQ=="
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "6HM6wFzgjNRxbj7DvcK5qP9DwbJHrK86p8AJgB33VwiL",
        "block_height": 218019338,
        "block_timestamp": 1790833040377904489,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};
export const DELETE: FastNearTx = {
  "transaction": {
    "hash": "FqFndxqxgHP52PeavuoDDpocw3xtKZfqwfda3oME2Py4",
    "signer_id": "intentfolio-budget.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_height": 218020054,
    "block_timestamp": 1790833460030331645,
    "outcome": {
      "receipt_ids": [
        "3H7hYksMHCWejLZ7At3atb3sdzfJr8jhXvQTGuMbWGWx"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "3H7hYksMHCWejLZ7At3atb3sdzfJr8jhXvQTGuMbWGWx",
        "block_height": 218020055,
        "block_timestamp": 1790833460640328836,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [
            "EVENT_JSON:{\"standard\":\"intentfolio-vault\",\"version\":\"2.0.0\",\"event\":\"portfolio_deleted\",\"data\":[{\"account_id\":\"pablofork.near\",\"portfolio_id\":\"p_000000000000\",\"by\":\"owner\"}]}"
          ],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "EUowSQnYPGKB7qx3s1DCVs2Mjk4SiVw5c5mwLXcDFhyS"
          ]
        }
      },
      "receipt": {
        "receipt_id": "3H7hYksMHCWejLZ7At3atb3sdzfJr8jhXvQTGuMbWGWx",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "commit_portfolio_changes",
                  "args": "eyJwYXlsb2FkIjp7InN0YW5kYXJkIjoibmVwNDEzIiwicGF5bG9hZCI6eyJtZXNzYWdlIjoie1wic2lnbmVyX2lkXCI6XCJwYWJsb2ZvcmsubmVhclwiLFwiZGVhZGxpbmVcIjpcIjIwMjYtMTAtMDFUMDU6NTQ6MTQuMDAwWlwiLFwicG9ydGZvbGlvX2lkXCI6XCJwXzAwMDAwMDAwMDAwMFwiLFwidGFyZ2V0X2NoYW5nZXNcIjpbXSxcInRva2VuX2FkZGl0aW9uc1wiOltdLFwidG9rZW5fcmVtb3ZhbHNcIjpbXSxcInVuYWxsb2NhdGlvbnNcIjpbXSxcImRlbGV0ZVwiOnRydWV9Iiwibm9uY2UiOiJWaWoyeGdBQUFBQUFBTHhYZUJWUzJoamxkZFlIRXBqZWduc0VnMW5SSWN3PSIsInJlY2lwaWVudCI6ImludGVudGZvbGlvLXZhdWx0Lm5lYXIifSwicHVibGljX2tleSI6ImVkMjU1MTk6MkVWZ3lIeVJaWlVXcmZmZUxyaWhZQjh2RkxXZndRdmU2TUE1ZWlXYVVmeFYiLCJzaWduYXR1cmUiOiJlZDI1NTE5OjI4dUozWVczR0NyOVRNcXFxc1ZuUVBWQkp6Q3ZIaXR6eGlhNHlDVlhMeUVwSnhFNDlkaEhoZDVDcWRMUkhkUlpWeDVyc1dQNHl5d3JWYjk3eGlSZHExeEUifX0="
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "EUowSQnYPGKB7qx3s1DCVs2Mjk4SiVw5c5mwLXcDFhyS",
        "block_height": 218020056,
        "block_timestamp": 1790833461263076349,
        "outcome": {
          "executor_id": "intentfolio-budget.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};
export const FAILED_ADMIN: FastNearTx = {
  "transaction": {
    "hash": "HAjPTka8s2VDbbi5eusDBaR2W8nJATQnYsiQubTkCayV",
    "signer_id": "intentfolio-admin.near",
    "receiver_id": "intentfolio-vault.near"
  },
  "execution_outcome": {
    "block_height": 217988949,
    "block_timestamp": 1790815130553220730,
    "outcome": {
      "receipt_ids": [
        "9CN3AFBWZuViJVnLodqzW1zMPypc9MUPuEi2gLMzj9VF"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "9CN3AFBWZuViJVnLodqzW1zMPypc9MUPuEi2gLMzj9VF",
        "block_height": 217988950,
        "block_timestamp": 1790815131202401132,
        "outcome": {
          "executor_id": "intentfolio-vault.near",
          "logs": [],
          "status": {
            "Failure": {}
          },
          "receipt_ids": [
            "Gyb2EvmDVu44HfytZUv5JQ8JzLKN68UYhGAtLSTds1Fn"
          ]
        }
      },
      "receipt": {
        "receipt_id": "9CN3AFBWZuViJVnLodqzW1zMPypc9MUPuEi2gLMzj9VF",
        "receipt": {
          "Action": {
            "actions": [
              {
                "FunctionCall": {
                  "method_name": "execute_return",
                  "args": ""
                }
              }
            ]
          }
        }
      }
    },
    {
      "execution_outcome": {
        "id": "Gyb2EvmDVu44HfytZUv5JQ8JzLKN68UYhGAtLSTds1Fn",
        "block_height": 217988951,
        "block_timestamp": 1790815131825008816,
        "outcome": {
          "executor_id": "intentfolio-admin.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};
export const NO_VAULT_RECEIPT: FastNearTx = {
  "transaction": {
    "hash": "2ZJcYoJL9Tk8XwsPJMhKNZnpx7DdjFBm5foHGKaNJtRg",
    "signer_id": "intents.near",
    "receiver_id": "intents.near"
  },
  "execution_outcome": {
    "block_height": 220124070,
    "block_timestamp": 1792094760668427433,
    "outcome": {
      "receipt_ids": [
        "FtBCqaPPGRpuPrvVC5Cezf28hwQ2h6tJGR6oZZdnHWQh"
      ]
    }
  },
  "receipts": [
    {
      "execution_outcome": {
        "id": "FtBCqaPPGRpuPrvVC5Cezf28hwQ2h6tJGR6oZZdnHWQh",
        "block_height": 220124070,
        "block_timestamp": 1792094760668427433,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "CBremWz2iKSzx5P3A9spz3fea95WUESgwFVSDKomEK2i",
            "ASTg91AbGVFRhucXr9JYTwSCm9RA9Bf6yZaBAT28f9LZ",
            "B3Vj16PKCGS4jw3g1BFAYZkdb9bk9PtCvJgfWT1NRPXA"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "CBremWz2iKSzx5P3A9spz3fea95WUESgwFVSDKomEK2i",
        "block_height": 220124071,
        "block_timestamp": 1792094761338300567,
        "outcome": {
          "executor_id": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "5jRuyJ5ihg8KaMTEQuca39F9wjdNXN6oqZyKZThZJXpn"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "B3Vj16PKCGS4jw3g1BFAYZkdb9bk9PtCvJgfWT1NRPXA",
        "block_height": 220124071,
        "block_timestamp": 1792094761338300567,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "5jRuyJ5ihg8KaMTEQuca39F9wjdNXN6oqZyKZThZJXpn",
        "block_height": 220124072,
        "block_timestamp": 1792094761901182971,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    },
    {
      "execution_outcome": {
        "id": "ASTg91AbGVFRhucXr9JYTwSCm9RA9Bf6yZaBAT28f9LZ",
        "block_height": 220124072,
        "block_timestamp": 1792094761901182971,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": [
            "3WMioDpciqVkSWMs7Nrze9RLiUoRxVsnP7M8eyb1gkPw"
          ]
        }
      }
    },
    {
      "execution_outcome": {
        "id": "3WMioDpciqVkSWMs7Nrze9RLiUoRxVsnP7M8eyb1gkPw",
        "block_height": 220124073,
        "block_timestamp": 1792094762457624739,
        "outcome": {
          "executor_id": "intents.near",
          "logs": [],
          "status": {
            "SuccessValue": ""
          },
          "receipt_ids": []
        }
      }
    }
  ]
};
