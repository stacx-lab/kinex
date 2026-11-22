import asyncio
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from kinex.communication import ambient
from kinex.lib.images import camera_geometry
from kinex.common.camera import rays

STREAM = {"width":4,"height":3,"frame":"camera/base","calibration_id":"one",
          "projection":{"fx":2,"fy":2,"cx":1,"cy":1,"skew":0},"distortion":{"model":"vendor"}}

class Geometry(unittest.IsolatedAsyncioTestCase):
    async def test_batches_round_trips_and_profile_checks(self):
        calls = []
        async def request(operation, **args):
            calls.append((operation,args))
            if operation.endswith(".geometry"):
                return {"streams":{"color":STREAM}}
            self.assertEqual(args["calibration_id"],"one")
            if operation.endswith(".unproject"):
                return {"rays":[[(u-1)/2,(v-1)/2,1] if u>=0 else None for u,v in args["pixels"]]}
            return {"pixels":[[x/z*2+1,y/z*2+1] for x,y,z in args["points"]]}
        self.enterContext(ambient(SimpleNamespace(catalog={"camera.geometry":{}},request=request)))
        with patch("kinex.lib.images.profile",return_value={"color":{"width":4,"height":3}}):
            geometry=await camera_geometry("camera")
        result=await geometry.unproject([[1,1]]*8193)
        self.assertEqual(result.shape,(8193,3))
        self.assertEqual([len(a["pixels"]) for _,a in calls if "pixels" in a],[8192,1])
        self.assertTrue(np.isnan((await geometry.unproject([[-1,0]]))[0]).all())
        pixel=[[3,2]]
        np.testing.assert_allclose(await geometry.project(await geometry.unproject(pixel)*2),pixel)
        with patch("kinex.lib.images.profile",return_value={"color":{"width":5}}):
            with self.assertRaisesRegex(ValueError,"differ"):
                await camera_geometry("camera")

    async def test_placeholder_profile_streams_defer_to_active_geometry(self):
        async def request(operation, **args):
            return {"streams":{"color":STREAM,"depth":STREAM}}
        self.enterContext(ambient(SimpleNamespace(catalog={"camera.geometry":{}},request=request)))
        with patch("kinex.lib.images.profile",return_value={"color":"???","depth":{"registration":"native","width":"???"}}):
            geometry=await camera_geometry("camera")
        self.assertEqual(set(geometry.streams),{"color","depth"})

    async def test_no_fallback_and_errors(self):
        with self.assertRaises(ValueError):
            rays(STREAM,0,0)
        for error in [TimeoutError(), asyncio.CancelledError()]:
            async def request(*args,**kwargs):
                raise error
            with patch("kinex.lib.images.profile",return_value={"color":STREAM}):
                with self.assertRaises(type(error)), ambient(SimpleNamespace(catalog={"camera.geometry":{}},request=request)):
                    await camera_geometry("camera")

    async def test_stale_ids(self):
        from kinex.common.camera_geometry import serve_geometry
        handlers={}
        adapter=SimpleNamespace(descriptor=STREAM,project=lambda points:[[1,1] for p in points],
                                unproject=lambda pixels:[[0,0,1] for p in pixels])
        with patch.dict(sys.modules, {"kinex.node": SimpleNamespace(json_service=lambda n,op,fn:handlers.update({op:fn}))}):
            serve_geometry(None,{"operations":{k:k for k in ("geometry","project","unproject")}},{"color":adapter})
        descriptor=handlers["geometry"]()["streams"]["color"]
        with self.assertRaisesRegex(ValueError,"stale"):
            handlers["unproject"]("color","old",[[1,1]])
        self.assertEqual(handlers["project"]("color",descriptor["calibration_id"],[[0,0,-1],[0,0,1]])["pixels"],[None,[1,1]])

if __name__=="__main__":
    unittest.main()
