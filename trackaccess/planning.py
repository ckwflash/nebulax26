"""Planning commitments and independent checks beyond the official scenario policy."""
from collections import defaultdict
from typing import Literal

from pydantic import Field, model_validator

from . import RULE_VERSION
from .domain import Record, Schedule

SOLVER_VERSION = f"planning-v1-{RULE_VERSION}"
Philosophy = Literal['churn', 'deadlines', 'passengers', 'p1', 'custom']


class Booking(Record):
    request_id: str = ''
    activity_id: str
    week_from: int = Field(ge=1)
    week_to: int = Field(ge=1)

    @model_validator(mode='after')
    def ordered(self):
        if self.week_to < self.week_from:
            raise ValueError('The end week must not precede the start week.')
        return self


class Weights(Record):
    churn: int = Field(default=6, ge=0, le=10)
    deadlines: int = Field(default=7, ge=0, le=10)
    passengers: int = Field(default=5, ge=0, le=10)
    priority1: int = Field(default=8, ge=0, le=10)


def placements(schedule):
    out = defaultdict(set)
    if schedule:
        for row in schedule.access:
            out[row.activity_id].add((row.week, row.eclo))
    return out


def check_planning(instance, schedule, report, bookings=(), philosophy=None, baseline=None):
    """Inspect exported decisions; do not reuse CP-SAT model expressions."""
    violations = report['hard_violations']
    def fail(rule, detail, aid=None):
        violations.append({'rule': rule, 'severity': 'hard', 'detail': detail, **({'activity_id': aid} if aid else {})})
    actual = placements(schedule)
    for raw in bookings:
        booking = raw if isinstance(raw, Booking) else Booking(**raw)
        if not any(booking.week_from <= week <= booking.week_to for week, _ in actual[booking.activity_id]):
            fail('booking_requirement', f'{booking.activity_id} needs an access in weeks {booking.week_from}–{booking.week_to}.', booking.activity_id)
    if philosophy and baseline:
        before = placements(baseline)
        if philosophy == 'p1':
            for aid, activity in instance.activities.items():
                if activity.activity_priority == 1 and actual[aid] != before[aid]:
                    fail('priority1_lock', f'{aid}: Priority-1 booked weeks and ECLO must remain unchanged.', aid)
        if philosophy == 'deadlines':
            ends = {row.contract_number: row.simulated_completion_date for row in baseline.results}
            for row in schedule.results:
                if row.simulated_completion_date > ends[row.contract_number]:
                    fail('baseline_deadline', f'{row.contract_number}: completion is later than the approved baseline.')
    report['feasible'] = not violations and report['safety_verified']
    report['structurally_valid'] = not violations
    if not report['feasible']:
        report['soft_scores'].pop('objective_score', None)
        report['soft_scores'].pop('formula_version', None)
    return report


def run_diff(before, after, old_report, new_report):
    a, b = placements(before), placements(after)
    old = {(aid, *row) for aid, rows in a.items() for row in rows}
    new = {(aid, *row) for aid, rows in b.items() for row in rows}
    return {'changed_activities': sorted(aid for aid in a.keys() | b.keys() if a[aid] != b[aid]),
            'removed_accesses': len(old - new), 'added_accesses': len(new - old),
            'score_delta': round(new_report['score'] - old_report['score'], 1) if before.scenario == after.scenario else None}


def objective_values(instance, schedule, report, baseline=None, philosophy=None, weights=None):
    """Comparable objective tuple used to retain a better checked incumbent on Improve."""
    actual, original = placements(schedule), placements(baseline)
    churn = sum(actual[aid] != original[aid] for aid in instance.activities)
    score_tenths = round(report['score'] * 10)
    if philosophy == 'churn':
        return (churn, score_tenths)
    if philosophy == 'custom':
        weights = weights if isinstance(weights, Weights) else Weights(**(weights or {}))
        delay, p1_delay = 0, 0
        contract_finish = defaultdict(int)
        for aid, activity in instance.activities.items():
            contract_finish[activity.contract_number] = max(contract_finish[activity.contract_number],
                                                          max(week for week, _ in actual[aid]))
        for aid, activity in instance.activities.items():
            project = instance.projects[activity.contract_number]
            finish = contract_finish[activity.contract_number]
            late = max(0, (instance.week_end(finish) - project.planned_completion_date).days) * instance.weight10(aid)
            delay += late
            if activity.activity_priority == 1:
                p1_delay += late
        soft = report['soft_scores']
        return (10 * weights.churn * churn + weights.deadlines * delay + 50 * weights.passengers * soft['eclo_nights_total']
                + weights.priority1 * p1_delay + 70 * soft['excess_access_nights_total'], churn)
    if philosophy:
        return (score_tenths, churn)
    secondary = (sum(len({w for w, _ in actual[aid]} ^ {w for w, _ in original[aid]}) for aid in instance.activities)
                 if baseline else sum(max(w for w, _ in actual[aid]) for aid in instance.activities))
    return (score_tenths, secondary)
