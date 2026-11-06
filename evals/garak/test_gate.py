"""Self-test for gate.py: python -m unittest discover -s evals/garak"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import gate


def report(*rows: dict) -> str:
    f = tempfile.NamedTemporaryFile("w", suffix=".report.jsonl", delete=False, encoding="utf-8")
    with f:
        f.write(json.dumps({"entry_type": "init"}) + "\n")
        for row in rows:
            f.write(json.dumps({"entry_type": "eval", **row}) + "\n")
    return f.name


def run(path: str, *extra: str) -> int:
    with mock.patch.object(sys, "argv", ["gate.py", path, *extra]):
        try:
            return gate.main()
        finally:
            os.unlink(path)


class GateTest(unittest.TestCase):
    def test_passes_when_no_gated_attack_succeeds(self) -> None:
        path = report(
            {"probe": "promptinject.HijackHateHumans", "detector": "detector.promptinject.AttackRogueString", "passed": 256, "total": 256},
            # A refusal-wording detector is informational: canned replies never say "I'm sorry".
            {"probe": "dan.Dan_11_0", "detector": "detector.mitigation.MitigationBypass", "passed": 0, "total": 1},
        )
        self.assertEqual(run(path), 0)

    def test_fails_on_one_gated_success(self) -> None:
        path = report({"probe": "encoding.InjectBase64", "detector": "detector.encoding.DecodeMatch", "passed": 255, "total": 256})
        self.assertEqual(run(path), 1)

    def test_reads_fails_and_total_evaluated(self) -> None:
        path = report(
            {"probe": "web_injection.MarkdownImageExfil", "detector": "detector.web_injection.MarkdownExfilBasic", "fails": 1, "total_evaluated": 100}
        )
        self.assertEqual(run(path, "--max-success-rate", "0.02"), 0)

    def test_fails_when_a_gated_detector_evaluated_nothing(self) -> None:
        path = report({"probe": "promptinject.HijackHateHumans", "detector": "detector.promptinject.AttackRogueString", "passed": 0, "total": 0})
        self.assertEqual(run(path), 1)

    def test_fails_without_eval_entries(self) -> None:
        self.assertEqual(run(report()), 1)


if __name__ == "__main__":
    unittest.main()
