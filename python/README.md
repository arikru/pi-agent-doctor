# pi-agent-doctor Python adapter

Reusable Pydantic AI diagnostics adapter bundled with the `pi-agent-doctor` Pi package.

Install from this repository:

```bash
pip install "pi-agent-doctor-adapter[server] @ git+https://github.com/arikru/pi-agent-doctor.git@v0.2.0#subdirectory=python"
```

Or, from a local checkout:

```bash
pip install -e "./python[server]"
```

Minimal FastAPI bridge for your own Pydantic AI agent:

```python
from pi_agent_doctor.fastapi_adapter import create_app
from my_agent import build_agent

app = create_app({"default": build_agent})
```

Run it:

```bash
uvicorn doctor_server:app --host 127.0.0.1 --port 8765
```

Then connect from Pi:

```text
/agent-connect default http://127.0.0.1:8765
/agent-debug hello
```
