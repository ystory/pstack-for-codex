#!/usr/bin/env python3
"""Parse managed Codex registrations using Python's standard TOML parser."""

import copy
import json
import math
import sys

if sys.version_info < (3, 11):
    sys.exit("Agent registration requires Python 3.11 or newer (tomllib).")

import tomllib

NAMES = ("poteto-agent", "comment-sicko", "pstack-general-purpose")


def read_config(text):
    config = tomllib.loads(text)
    agents = config.get("agents", {})
    if not isinstance(agents, dict):
        raise ValueError("Codex agents must be a TOML table.")
    return config, agents


def normalized(value):
    if isinstance(value, dict):
        return {key: normalized(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalized(item) for item in value]
    if isinstance(value, float) and math.isnan(value):
        return ("toml-nan",)
    return value


try:
    request = json.load(sys.stdin)
    mode = sys.argv[1]
    if mode == "agent":
        agent = tomllib.loads(request["text"])
        if not all(isinstance(agent.get(key), str) for key in ("name", "description", "developer_instructions")):
            raise ValueError("Bundled agent must declare its name, description, and instructions.")
        response = {"name": agent["name"], "description": agent["description"]}
    elif mode == "inspect":
        config, agents = read_config(request["text"])
        response = {"roles": {name: agents[name] for name in NAMES if name in agents}}
    elif mode == "compare-remove":
        before, agents = read_config(request["text"])
        after, _ = read_config(request["afterText"])
        expected = copy.deepcopy(before)
        names = request.get("names", list(NAMES))
        if not isinstance(names, list) or any(name not in NAMES for name in names):
            raise ValueError("Unknown managed role in config comparison.")
        for name in names:
            expected.get("agents", {}).pop(name, None)
        for config in (expected, after):
            if config.get("agents") == {}:
                config.pop("agents", None)
        if normalized(expected) != normalized(after):
            raise ValueError("Removing the managed block would change unrelated TOML settings.")
        response = {"unchangedUnrelatedSettings": True}
    else:
        raise ValueError("Unknown TOML validation operation.")
    print(json.dumps(response))
except (ValueError, KeyError, TypeError, tomllib.TOMLDecodeError) as error:
    sys.exit(f"TOML registration validation failed: {error}")
