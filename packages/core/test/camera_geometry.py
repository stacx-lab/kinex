import asyncio
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from kinex.helpers.camera_geometry import camera_geometry
from kinex.helpers.perception import _locate
from kinex.lib.camera import ray

STREAM = {"width":4,"height":3,"frame":"camera/base","calibration_id":"one",
          "projection":{"fx":2,"fy":2,"cx":1,"cy":1,"skew":0},"distortion":{"model":"vendor"}}

class Geometry(unittest.IsolatedAsyncioTestCase):
    async def test_batches_and_localization(self):
        calls = []
        async def request(operation, **args):
            calls.append((operation,args))
            if operation.endswith(".geometry"):
                return {"streams":{"color":STREAM}}
            self.assertEqual(args["calibration_id"],"one")
            if operation.endswith(".unproject"):
                return {"rays":[[(u-1)/2,(v-1)/2,1] if u>=0 else None for u,v in args["pixels"]]}
            return {"pixels":[[x/z*2+1,y/z*2+1] for x,y,z in args["points"]]}
        io=SimpleNamespace(catalog={"camera.geometry":{}},request=request)
        with patch("kinex.helpers.camera_geometry.profile",return_value={"color":{"width":4,"height":3}}):
            geometry=await camera_geometry(io,"camera")
        result=await geometry.unproject([[1,1]]*8193)
        self.assertEqual(result.shape,(8193,3))
        self.assertEqual([len(a["pixels"]) for _,a in calls if "pixels" in a],[8192,1])
        self.assertTrue(np.isnan((await geometry.unproject([[-1,0]]))[0]).all())
        result=await _locate({"color":STREAM},np.ones((3,4),bool),depth=2,geometry=geometry)
        np.testing.assert_allclose(await geometry.project([result["point"]]),[result["pixel"]])
        with patch("kinex.helpers.camera_geometry.profile",return_value={"color":{"width":5}}):
            with self.assertRaisesRegex(ValueError,"differ"):
                await camera_geometry(io,"camera")

    async def test_raw_pixels_and_native_depth(self):
        import os
        from PIL import Image
        from kinex.helpers import perception
        from unittest.mock import AsyncMock
        descriptor = {**STREAM, "distortion": {"model": "none"}}
        raw = np.arange(36, dtype=np.uint8).reshape(3,4,3)
        image = SimpleNamespace(encoding="rgb8",width=4,height=3,step=12,is_bigendian=False,
            data=raw.tobytes(),header=SimpleNamespace(frame_id="camera/base",stamp=SimpleNamespace(sec=1,nanosec=0)))
        depth_values = np.ones((3,4),dtype=np.uint16)*2000
        depth_image = SimpleNamespace(encoding="16UC1",width=4,height=3,step=8,is_bigendian=False,
            data=depth_values.tobytes(),header=image.header)
        paths = []
        async def request(operation, **args):
            if operation.endswith(".geometry"):
                return {"streams":{"color":descriptor,"depth":descriptor}}
            if operation.endswith(".unproject"):
                return {"rays":[[(u-1)/2,(v-1)/2,1] for u,v in args["pixels"]]}
            if operation.endswith(".project"):
                return {"pixels":[[x/z*2+1,y/z*2+1] for x,y,z in args["points"]]}
            paths.append(args["image"])
            with Image.open(args["image"]) as saved:
                np.testing.assert_array_equal(saved,raw)
            return {"results":[{"box":[0,0,4,3],"score":.9}]}
        io=SimpleNamespace(catalog={"camera.geometry":{}},request=request)
        depth = {"registration":"native","width":4,"height":3,"quantity":"z",
                 "scale_m_per_unit":.001,"invalid_value":0,"valid_range_m":{"min":.1,"max":5},"reliable_range_m":"???"}
        record={"color":"???","depth":depth}
        with patch("kinex.helpers.camera_geometry.profile",return_value=record):
            geometry=await camera_geometry(io,"camera")
        for registration in ["native","color"]:
            result=await _locate({"color":descriptor,"depth":{**depth,"registration":registration}},
                np.ones((3,4),bool),depth_image=depth_image,geometry=geometry,depth_to_color=(np.eye(3),np.zeros(3)))
            self.assertEqual(result["depth_samples"],12)
        try:
            with patch.object(perception,"profile",return_value=record), patch.object(perception,"camera_geometry",new=AsyncMock(return_value=geometry)),patch.object(perception,"frame",new=AsyncMock(return_value=(image,None))):
                result=await perception.locate_object_3d(io,"camera","sam3","object",depth=2)
            self.assertEqual(result["point"][2],2)
        finally:
            for path in paths:
                os.unlink(path)

    async def test_no_fallback_and_errors(self):
        with self.assertRaises(ValueError):
            ray(STREAM,0,0)
        for error in [TimeoutError(), asyncio.CancelledError()]:
            async def request(*args,**kwargs):
                raise error
            with patch("kinex.helpers.camera_geometry.profile",return_value={"color":STREAM}):
                with self.assertRaises(type(error)):
                    await camera_geometry(SimpleNamespace(catalog={"camera.geometry":{}},request=request),"camera")

    async def test_stale_ids(self):
        from kinex.lib.camera_geometry import serve_geometry
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
